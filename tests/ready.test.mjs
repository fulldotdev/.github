import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../.github/workflows/ready.yml', import.meta.url), 'utf8')
  .split('          script: |\n')[1].split('\n').map(line => line.slice(12)).join('\n');
const execute = new (Object.getPrototypeOf(async function () {}).constructor)('github', 'context', 'core', 'process', 'fetch', 'setTimeout', source);

async function scenario(options = {}) {
  const pull = {number: 1, node_id: 'PR1', state: 'open', draft: false, head: {sha: 'head', ref: 'preview', repo: {full_name: 'o/r'}},
    base: {ref: 'main', repo: {full_name: 'o/r'}}, user: {type: 'Bot', login: 'cloudcannon[bot]'}, labels: options.selected ? [{name: 'review-ready'}] : [], html_url: 'https://github.com/o/r/pull/1',
    ...options.pull};
  const pulls = options.pulls ?? [pull];
  const errors = [];
  const statuses = [];
  const merges = [];
  let reads = 0;
  let runReads = 0;
  let jobReads = 0;
  const checks = () => (options.checks ?? [{id: 1, name: 'Check / Check', app: {id: 15368}, conclusion: 'success'}]).map(check =>
    Object.hasOwn(check, 'details_url') ? check : {...check, details_url: `https://github.com/o/r/actions/runs/${check.id}/job/${check.id}`});
  const defaultRuns = () => checks().filter(check => check.name === 'Test / Test' && check.app?.id === 15368)
    .map(check => ({id: Number(check.details_url?.match(/\/actions\/runs\/(\d+)/)?.[1]), run_attempt: 1,
      name: 'Test', path: '.github/workflows/test.yml', head_sha: 'head', status: check.status, conclusion: check.conclusion}))
    .filter(run => run.id);
  const github = {
    rest: {
      pulls: {get: async ({pull_number}) => ({data: ++reads >= 2 && options.changed ? {...pull, head: {sha: 'new'}} : pulls.find(candidate => candidate.number === pull_number)}),
        list: 'pulls', merge: async args => { if (options.rejectPull === args.pull_number) throw Object.assign(new Error('Head changed'), {status: 409}); merges.push(args); }},
      repos: {get: async () => ({data: {default_branch: 'main', full_name: 'o/r', allow_auto_merge: options.autoMerge !== false}}),
        getCombinedStatusForRef: async ({ref}) => {
          if (options.statusError) throw new Error('Status unavailable');
          assert.ok(pulls.some(candidate => candidate.head.sha === ref), 'Statuses are read for a PR head');
          return {data: {statuses: [...options.review ? [{context: 'Review', ...options.review}] : [],
            ...options.previews ?? (options.netlify ?? []).map(context => ({context, state: 'success'}))]}};
        },
        createCommitStatus: async status => statuses.push(status)},
      checks: {listForRef: 'checks'},
      actions: {listWorkflowRunsForRepo: 'runs', listJobsForWorkflowRunAttempt: 'jobs'},
    },
    paginate: async (endpoint, parameters) => endpoint === 'pulls' ? pulls
      : endpoint === 'runs' ? options.runRead ? options.runRead(++runReads) : options.runs ?? defaultRuns()
      : endpoint === 'jobs' ? options.jobRead ? options.jobRead(++jobReads, parameters) : options.jobs ?? checks()
      : checks(),
    request: async () => ({data: [{type: 'required_status_checks', parameters: {
      required_status_checks: (options.required ?? ['Check / Check', 'Review']).map(context => ({context})),
    }}]}),
    graphql: async (query, args) => {
      // Octokit reserves request options instead of treating them as GraphQL variables.
      for (const reserved of ['method', 'url', 'baseUrl', 'headers', 'request']) {
        assert.equal(Object.hasOwn(args, reserved), false, `Reserved GraphQL variable: ${reserved}`);
      }
      assert.match(query, /mergeMethod: \$mergeMethod/);
      merges.push(args);
    },
  };
  await execute(github, {repo: {owner: 'o', repo: 'r'}, payload: options.event ?? {pull_request: {number: 1}}},
    {info: () => {}, error: message => errors.push(message), setFailed: message => errors.push(message)}, {env: {CHECK_NAME: 'Check / Check', NETLIFY_CHECKS: JSON.stringify(options.netlify ?? []),
      TEST_CHECKS: JSON.stringify(options.testChecks ?? []),
      GITHUB_API_URL: 'https://api.github.com', MERGE_TOKEN: options.mergeToken}},
    options.fetch ?? (() => { throw new Error('Unexpected network request'); }), resolve => resolve());
  return {statuses, merges, errors, runReads};
}

test('CloudCannon publication with real checks enables auto-merge', async () => {
  const result = await scenario();
  assert.equal(result.statuses[0].state, 'success');
  assert.equal(result.merges.length, 1);
});
test('draft remains pending and cannot auto-merge', async () => {
  const result = await scenario({pull: {draft: true}});
  assert.equal(result.statuses[0].state, 'pending');
  assert.equal(result.merges.length, 0);
});
test('pending drafts do not append statuses or query Test metadata on repeated events', async () => {
  for (const description of ['Draft: publication is not authorized.', 'Checking the current Test run and attempt.']) {
    const result = await scenario({pull: {draft: true}, testChecks: ['Test / Test'],
      review: {state: 'pending', description}, runRead: () => {throw new Error('Draft must not query Test');}});
    assert.deepEqual(result.statuses, []);
    assert.equal(result.runReads, 0);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.merges, []);
  }
});
test('converting a successful PR to draft revokes its old Review', async () => {
  const result = await scenario({pull: {draft: true}, testChecks: ['Test / Test'],
    review: {state: 'success'}, runRead: () => {throw new Error('Draft must not query Test');}});
  assert.equal(result.statuses.length, 1);
  assert.equal(result.statuses[0].state, 'pending');
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.merges, []);
});
test('an already-pending ready PR waits without another status write', async () => {
  const result = await scenario({testChecks: ['Test / Test'], review: {state: 'pending'},
    runs: [{id: 100, name: 'Test', path: '.github/workflows/test.yml', head_sha: 'head', status: 'in_progress'}]});
  assert.deepEqual(result.statuses, []);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.merges, []);
});
test('a status read failure revokes any previous success before failing Ready', async () => {
  const result = await scenario({statusError: true, review: {state: 'success'}});
  assert.equal(result.statuses.at(-1).state, 'pending');
  assert.match(result.errors[0], /Status unavailable/);
  assert.deepEqual(result.merges, []);
});
test('skipped, failed or absent static checks never authorize publication', async () => {
  for (const checks of [[], [{id: 1, name: 'Check / Check', app: {id: 15368}, conclusion: 'skipped'}],
    [{id: 1, name: 'Check / Check', app: {id: 15368}, conclusion: 'failure'}]]) {
    assert.equal((await scenario({checks})).merges.length, 0);
  }
});
test('a newer pending Check supersedes an older successful one', async () => {
  const checks = [
    {id: 1, name: 'Check / Check', app: {id: 15368}, conclusion: 'success'},
    {id: 2, name: 'Check / Check', app: {id: 15368}, conclusion: null},
  ];
  assert.equal((await scenario({checks})).merges.length, 0);
});
test('missing central requirements or disabled repository auto-merge prevents rollout races', async () => {
  assert.equal((await scenario({required: ['Check / Check']})).merges.length, 0);
  assert.equal((await scenario({autoMerge: false})).merges.length, 0);
});
test('changed revision, closed PR or another target does not publish', async () => {
  for (const options of [{changed: true}, {pull: {state: 'closed'}}, {pull: {base: {ref: 'preview'}}}]) {
    const result = await scenario(options);
    assert.equal(result.statuses.length, 0);
    assert.equal(result.merges.length, 0);
  }
});
test('successful Check workflow completion resumes the associated PR', async () => {
  assert.equal((await scenario({event: {workflow_run: {pull_requests: [{number: 1}]}}})).merges.length, 1);
  assert.equal((await scenario({event: {workflow_run: {pull_requests: []}}})).merges.length, 1);
});
test('already-green PR merges immediately with the validated SHA', async () => {
  const result = await scenario({pull: {mergeable_state: 'clean'}});
  assert.deepEqual(result.merges, [{owner: 'o', repo: 'r', pull_number: 1, sha: 'head', merge_method: 'merge'}]);
});
test('automatic merge is bound to the validated head', async () => {
  assert.deepEqual((await scenario()).merges, [{id: 'PR1', sha: 'head', mergeMethod: 'MERGE'}]);
});
test('unrequired failures do not strand an otherwise eligible PR', async () => {
  const result = await scenario({pull: {mergeable_state: 'unstable'}});
  assert.deepEqual(result.merges, [{owner: 'o', repo: 'r', pull_number: 1, sha: 'head', merge_method: 'merge'}]);
  const denied = await scenario({pull: {mergeable_state: 'unstable'}, rejectPull: 1});
  assert.equal(denied.merges.length, 0);
  assert.match(denied.errors[0], /Head changed/);
});
test('Review waits for every Netlify preview of the revision', async () => {
  const netlify = ['netlify/app/deploy-preview', 'netlify/site/deploy-preview'];
  for (const state of ['pending', 'failure', undefined]) {
    const previews = [{context: netlify[0], state: 'success'}, ...state ? [{context: netlify[1], state}] : []];
    const result = await scenario({netlify, previews});
    assert.equal(result.statuses.at(-1).state, 'pending');
    assert.equal(result.merges.length, 0);
  }
  const passed = await scenario({netlify, required: ['Check / Check', 'Review']});
  assert.equal(passed.statuses.at(-1).state, 'success');
  assert.equal(passed.merges.length, 1);
});
test('every event reconciles other open PRs, even when concurrency coalesces events', async () => {
  const pulls = [1, 2].map(number => ({number, node_id: `PR${number}`, state: 'open', draft: false,
    head: {sha: `head${number}`, ref: 'preview', repo: {full_name: 'o/r'}}, base: {ref: 'main', repo: {full_name: 'o/r'}}, user: {type: 'Bot', login: 'cloudcannon[bot]'}, labels: [], html_url: `https://github.com/o/r/pull/${number}`}));
  const result = await scenario({pulls, event: {pull_request: {number: 2}}});
  assert.deepEqual(result.merges.map(merge => merge.id), ['PR1', 'PR2']);
});
test('a rejected merge does not stop reconciliation of later PRs', async () => {
  const pulls = [1, 2].map(number => ({number, node_id: `PR${number}`, state: 'open', draft: false,
    head: {sha: `head${number}`, ref: 'preview', repo: {full_name: 'o/r'}}, base: {ref: 'main', repo: {full_name: 'o/r'}}, user: {type: 'Bot', login: 'cloudcannon[bot]'}, labels: [], mergeable_state: 'clean',
    html_url: `https://github.com/o/r/pull/${number}`}));
  const result = await scenario({pulls, rejectPull: 1});
  assert.deepEqual(result.merges.map(merge => merge.pull_number), [2]);
  assert.match(result.errors[0], /PR #1: Head changed/);
  assert.equal(result.errors.length, 2);
});

test('CloudCannon preview merges preserve ancestry', async () => {
  const result = await scenario({pull: {mergeable_state: 'clean',
    head: {sha: 'head', ref: 'preview', repo: {full_name: 'o/r'}},
    base: {ref: 'main', repo: {full_name: 'o/r'}}}});
  assert.equal(result.merges[0].merge_method, 'merge');
});

test('release app handles only the merge while Review remains an Actions status', async () => {
  for (const mergeable_state of ['clean', 'unstable', 'blocked']) {
    const requests = [];
    const result = await scenario({mergeToken: 'synthetic-token', pull: {mergeable_state},
      fetch: async (url, options) => { requests.push({url, options});
        return {ok: true, status: 200, json: async () => ({merged: true})}; }});
    assert.equal(result.statuses[0].state, 'success');
    assert.equal(result.merges.length, 0);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].options.headers.Authorization, 'Bearer synthetic-token');
    const body = JSON.parse(requests[0].options.body);
    if (mergeable_state !== 'blocked') assert.deepEqual(body, {sha: 'head', merge_method: 'merge'});
    else assert.deepEqual(body.variables, {id: 'PR1', sha: 'head', mergeMethod: 'MERGE'});
  }
});
test('release app rejection is reported without treating the PR as merged', async () => {
  const result = await scenario({mergeToken: 'synthetic-token', pull: {mergeable_state: 'clean'},
    fetch: async () => ({ok: false, status: 409, json: async () => ({message: 'Head changed'})})});
  assert.equal(result.merges.length, 0);
  assert.match(result.errors[0], /Merge request failed \(409\)/);
});


test('delayed draft job does not supersede the newer Ready workflow', async () => {
  const checks = [
    {id: 116021792205, name: 'Check / Check', app: {id: 15368}, conclusion: 'skipped',
      details_url: 'https://github.com/o/r/actions/runs/38613265941/job/116021792205'},
    {id: 116021772853, name: 'Check / Check', app: {id: 15368}, conclusion: 'success',
      details_url: 'https://github.com/o/r/actions/runs/38613266353/job/116021772853'},
  ];
  assert.equal((await scenario({checks})).merges.length, 1);
  for (const conclusion of [null, 'failure', 'skipped']) {
    checks[1].conclusion = conclusion;
    assert.equal((await scenario({checks})).merges.length, 0);
  }
});
test('newer Ready workflow and latest attempt supersede old successful jobs', async () => {
  for (const newerRun of [100, 101]) {
    const checks = [
      {id: 200, name: 'Check / Check', app: {id: 15368}, conclusion: 'success',
        details_url: 'https://github.com/o/r/actions/runs/100/job/200'},
      {id: newerRun === 100 ? 201 : 199, name: 'Check / Check', app: {id: 15368}, conclusion: 'failure',
        details_url: `https://github.com/o/r/actions/runs/${newerRun}/job/new`},
    ];
    assert.equal((await scenario({checks})).merges.length, 0);
  }
});

test('mixed or absent workflow metadata cannot authorize an old successful result', async () => {
  for (const conclusion of ['failure', null, 'skipped', 'success']) {
    const checks = [
      {id: 116021792205, name: 'Check / Check', app: {id: 15368}, conclusion: 'success', details_url: null},
      {id: 116021772853, name: 'Check / Check', app: {id: 15368}, conclusion,
        details_url: 'https://github.com/o/r/actions/runs/38613266353/job/116021772853'},
    ];
    assert.equal((await scenario({checks})).merges.length, 0);
  }
  assert.equal((await scenario({checks: [{id: 1, name: 'Check / Check', app: {id: 15368},
    conclusion: 'success', details_url: 'invalid'}]})).merges.length, 0);
});


test('ordinary Ready code PRs pass Review without any automatic merge', async () => {
  for (const pull of [
    {user: {type: 'User', login: 'silveltman'}},
    {user: {type: 'Bot', login: 'dependabot[bot]'}},
    {head: {sha: 'head', ref: 'feature/code', repo: {full_name: 'o/r'}}},
    {head: {sha: 'head', ref: 'preview', repo: {full_name: 'fork/r'}}},
    {head: {sha: 'head', ref: 'preview'}},
  ]) {
    for (const mergeable_state of ['clean', 'blocked', 'unstable']) {
      const result = await scenario({pull: {...pull, mergeable_state}});
      assert.equal(result.statuses[0].state, 'success');
      assert.equal(result.merges.length, 0);
    }
  }
});

test('legacy review labels do not add an external review dependency', async () => {
  const result = await scenario({selected: true,
    pull: {user: {type: 'User', login: 'silveltman'}}});
  assert.equal(result.statuses[0].state, 'success');
  assert.equal(result.merges.length, 0);
});

test('required tests gate Review for ordinary PRs without adding an organization rule', async () => {
  const options = {testChecks: ['Test / Test'],
    pull: {user: {type: 'User', login: 'silveltman'}}};
  for (const check of [null,
    {id: 1, name: 'Test / Test', app: {id: 15368}, status: 'completed', conclusion: 'skipped'},
    {id: 1, name: 'Test / Test', app: {id: 15368}, status: 'completed', conclusion: 'failure'},
    {id: 1, name: 'Test / Test', app: {id: 15368}, status: 'in_progress', conclusion: null},
    {id: 1, name: 'Test / Test', app: {id: 1}, status: 'completed', conclusion: 'success'}]) {
    assert.equal((await scenario({...options, checks: check ? [check] : []})).statuses.at(-1).state, 'pending');
  }
  const passed = {id: 2, name: 'Test / Test', app: {id: 15368}, status: 'completed', conclusion: 'success'};
  assert.equal((await scenario({...options, checks: [passed]})).statuses.at(-1).state, 'success');
  assert.equal((await scenario({...options, checks: [passed, {...passed, id: 3, status: 'in_progress', conclusion: null}]})).statuses.at(-1).state, 'pending');
  assert.equal((await scenario({...options, checks: [{...passed, details_url: null}]})).statuses.at(-1).state, 'pending');
  assert.equal((await scenario({...options, checks: [passed], event: {workflow_run: {
    name: 'Test', head_sha: 'head', id: 3, status: 'queued'}}})).statuses.at(-1).state, 'pending');
  assert.equal((await scenario({...options, checks: [passed], event: {workflow_run: {
    name: 'Test', head_sha: 'head', id: 3, status: 'completed', conclusion: 'failure'}}})).statuses.at(-1).state, 'pending');
  assert.equal((await scenario({...options, checks: [passed], runs: [{id: 2, run_attempt: 1, name: 'Test', path: '.github/workflows/test.yml', head_sha: 'head', status: 'completed', conclusion: 'failure'}], event: {workflow_run: {
    name: 'Test', head_sha: 'head', id: 2, status: 'completed', conclusion: 'failure'}}})).statuses.at(-1).state, 'pending');
});

const trial = {testChecks: ['Test / Test'], pull: {user: {type: 'User', login: 'silveltman'}}};
const testRun = {id: 100, run_attempt: 1, name: 'Test', path: '.github/workflows/test.yml', head_sha: 'head', status: 'completed', conclusion: 'success'};
const testJob = {id: 200, name: 'Test / Test', status: 'completed', conclusion: 'success'};

test('Check events cannot pass a Test rerun using the preceding successful check', async () => {
  const result = await scenario({...trial, checks: [{...testJob, app: {id: 15368}}],
    runs: [{...testRun, run_attempt: 2, status: 'in_progress', conclusion: null}], jobs: [testJob],
    event: {workflow_run: {name: 'Check', head_sha: 'head', status: 'completed', conclusion: 'success'}}});
  assert.equal(result.statuses.at(-1).state, 'pending');
});

test('the exact latest Test attempt supplies every required successful job', async () => {
  for (const jobs of [[], [{...testJob, conclusion: 'skipped'}], [{...testJob, conclusion: 'failure'}]]) {
    const result = await scenario({...trial, runs: [{...testRun, run_attempt: 2}], jobRead: (_, parameters) => {
      assert.equal(parameters.run_id, 100);
      assert.equal(parameters.attempt_number, 2);
      return jobs;
    }});
    assert.equal(result.statuses.at(-1).state, 'pending');
  }
  const result = await scenario({...trial, runs: [{...testRun, run_attempt: 2}], jobs: [testJob]});
  assert.equal(result.statuses.at(-1).state, 'success');
});

test('other PRs\' events do not rewrite an unchanged successful Review', async () => {
  // GitHub refuses more than 1000 statuses per commit and context.
  const passed = {...trial, runs: [testRun], jobs: [testJob],
    review: {state: 'success', description: 'Ready requirements passed for this revision.'}};
  for (const event of [{pull_request: {number: 2}}, {workflow_run: {name: 'Check', head_sha: 'other'}}, {sha: 'other'}]) {
    const result = await scenario({...passed, event});
    assert.deepEqual(result.statuses, []);
    assert.deepEqual(result.errors, []);
  }
  // The PR's own events still block the old success before checking.
  const own = await scenario(passed);
  assert.deepEqual(own.statuses.map(status => status.state), ['pending', 'success']);
});
test('a PR changing while it is checked loses its old success', async () => {
  const result = await scenario({changed: true, review: {state: 'success'}, event: {pull_request: {number: 2}}});
  assert.deepEqual(result.statuses.map(status => status.state), ['pending']);
});

test('completion retries metadata lag and passes without requiring another event', async () => {
  let jobReads = 0;
  const result = await scenario({...trial,
    event: {workflow_run: {...testRun, id: 101}},
    runRead: reads => [reads === 1 ? testRun : {...testRun, id: 101}],
    jobRead: () => ++jobReads === 1 ? [] : [testJob]});
  assert.equal(result.statuses.at(-1).state, 'success');
  assert.ok(jobReads >= 2);
});

test('persistent missing metadata is bounded and API errors revoke old success', async () => {
  let reads = 0;
  const missing = await scenario({...trial, runRead: () => {reads++; return [];}});
  assert.equal(reads, 4);
  assert.equal(missing.statuses.at(-1).state, 'pending');
  const failed = await scenario({...trial, review: {state: 'success'},
    runRead: () => {throw new Error('Metadata unavailable');}});
  assert.equal(failed.statuses.at(-1).state, 'pending');
  assert.match(failed.errors[0], /Metadata unavailable/);
});

test('completion retries the same run and attempt while its status is stale', async () => {
  let runReads = 0;
  let jobReads = 0;
  const result = await scenario({...trial, event: {workflow_run: testRun},
    runRead: () => [++runReads === 1 ? {...testRun, status: 'in_progress', conclusion: null} : testRun],
    jobRead: () => {jobReads++; return [testJob];}});
  assert.equal(result.statuses.at(-1).state, 'success');
  assert.ok(runReads >= 3);
  assert.equal(jobReads, 2);
  assert.deepEqual(result.errors, []);
});

test('a completed older attempt cannot authorize a newer pending attempt', async () => {
  const result = await scenario({...trial, event: {workflow_run: testRun},
    runs: [{...testRun, run_attempt: 2, status: 'in_progress', conclusion: null}], jobs: [testJob]});
  assert.equal(result.statuses.at(-1).state, 'pending');
  assert.deepEqual(result.errors, []);
});

test('persistent lag after successful completion fails Ready instead of silently waiting', async () => {
  for (const options of [
    {runs: [{...testRun, status: 'in_progress', conclusion: null}]},
    {runs: [testRun], jobs: []},
    {runs: []},
  ]) {
    const result = await scenario({...trial, ...options, event: {workflow_run: testRun}});
    assert.equal(result.statuses.at(-1).state, 'pending');
    assert.match(result.errors[0], /metadata is still incomplete/);
    assert.match(result.errors.at(-1), /could not be reconciled/);
  }
});
