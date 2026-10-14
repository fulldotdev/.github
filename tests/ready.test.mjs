import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../.github/workflows/ready.yml', import.meta.url), 'utf8')
  .split('          script: |\n')[1].split('\n').map(line => line.slice(12)).join('\n');
const execute = new (Object.getPrototypeOf(async function () {}).constructor)('github', 'context', 'core', 'process', source);

async function scenario(options = {}) {
  const pull = {number: 1, node_id: 'PR1', state: 'open', draft: false, head: {sha: 'head'},
    base: {ref: 'main'}, labels: options.selected ? [{name: 'review-ready'}] : [], html_url: 'https://github.com/o/r/pull/1',
    ...options.pull};
  const statuses = [];
  const merges = [];
  let reads = 0;
  const github = {
    rest: {
      pulls: {get: async () => ({data: ++reads >= 2 && options.changed ? {...pull, head: {sha: 'new'}} : pull}), listReviews: 'reviews'},
      repos: {get: async () => ({data: {default_branch: 'main', allow_auto_merge: options.autoMerge !== false}}),
        createCommitStatus: async status => statuses.push(status)},
      checks: {listForRef: 'checks'},
    },
    paginate: async endpoint => endpoint === 'reviews' ? (options.reviews ?? [])
      : (options.checks ?? [{id: 1, name: 'Check / Check', app: {id: 15368}, conclusion: 'success'}]),
    request: async () => ({data: [{type: 'required_status_checks', parameters: {
      required_status_checks: (options.required ?? ['Check / Check', 'Review']).map(context => ({context})),
    }}]}),
    graphql: async (_, args) => merges.push(args),
  };
  await execute(github, {repo: {owner: 'o', repo: 'r'}, payload: options.event ?? {pull_request: {number: 1}}},
    {info: () => {}}, {env: {CHECK_NAME: 'Check / Check'}});
  return {statuses, merges};
}

const approval = {id: 1, user: {type: 'Bot', login: 'coderabbitai[bot]'}, state: 'APPROVED', commit_id: 'head'};

test('Ready with real checks and no selected review enables auto-merge', async () => {
  const result = await scenario();
  assert.equal(result.statuses[0].state, 'success');
  assert.equal(result.merges.length, 1);
});
test('draft remains pending and cannot auto-merge', async () => {
  const result = await scenario({pull: {draft: true}});
  assert.equal(result.statuses[0].state, 'pending');
  assert.equal(result.merges.length, 0);
});
test('selected but missing, skipped or rate-limited review stays pending', async () => {
  const result = await scenario({selected: true});
  assert.equal(result.statuses[0].state, 'pending');
  assert.equal(result.merges.length, 0);
});
test('selected approval must be from CodeRabbit at the current revision', async () => {
  for (const review of [{...approval, commit_id: 'old'}, {...approval, user: {type: 'User', login: 'coderabbitai[bot]'}},
    {...approval, user: {type: 'Bot', login: 'another[bot]'}}]) {
    const result = await scenario({selected: true, reviews: [review]});
    assert.equal(result.statuses[0].state, 'pending');
    assert.equal(result.merges.length, 0);
  }
  assert.equal((await scenario({selected: true, reviews: [approval]})).merges.length, 1);
});
test('requested changes or dismissed approval supersede an earlier approval', async () => {
  for (const state of ['CHANGES_REQUESTED', 'DISMISSED']) {
    const result = await scenario({selected: true, reviews: [approval, {...approval, id: 2, state}]});
    assert.equal(result.statuses[0].state, 'pending');
    assert.equal(result.merges.length, 0);
  }
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
  assert.equal((await scenario({event: {workflow_run: {pull_requests: []}}})).merges.length, 0);
});
