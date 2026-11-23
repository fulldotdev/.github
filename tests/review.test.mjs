import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import test from 'node:test';

const review = createRequire(import.meta.url)('../.github/actions/review/review.cjs');

// One Review run against canned statuses: `statuses` gives the head's
// statuses per poll, the last one repeating.
async function run({needs = {check: {result: 'success'}}, previews = [], statuses = [[]], pull = {}, current = {}, autoMerge = null, refuse, unreadable} = {}) {
  const failures = [];
  const merges = [];
  let polls = 0;
  let clock = 0;
  const github = {
    rest: {
      repos: {getCombinedStatusForRef: async ({ref}) => {
        assert.equal(ref, 'head');
        return {data: {statuses: statuses[Math.min(polls++, statuses.length - 1)]}};
      }},
      pulls: {get: async () => {
        if (unreadable) throw new Error('Resource not accessible by integration');
        return {data: {state: 'open', draft: false, head: {sha: 'head'}, base: {ref: 'main'}, auto_merge: autoMerge, ...current}};
      }},
    },
    graphql: async (query, variables) => {
      if (refuse) throw new Error(refuse);
      assert.match(query, /mergeMethod: MERGE/);
      merges.push(variables);
    },
  };
  await review({
    github,
    context: {repo: {owner: 'o', repo: 'r'}, payload: {pull_request: {number: 1, node_id: 'PR1', draft: false,
      head: {sha: 'head', ref: 'feature', repo: {full_name: 'o/r'}}, base: {ref: 'main'}, user: {login: 'someone'}, ...pull}}},
    core: {setFailed: message => failures.push(message), info: () => {}},
    env: {NEEDS: needs === null ? '' : JSON.stringify(needs), NETLIFY_CHECKS: JSON.stringify(previews), TIMEOUT_MINUTES: '1'},
    sleep: async ms => { clock += ms; },
    now: () => clock,
  });
  return {failures, merges, polls};
}

const preview = 'netlify/site/deploy-preview';
const cloudcannon = {user: {login: 'cloudcannon[bot]'}, head: {sha: 'head', ref: 'preview', repo: {full_name: 'o/r'}}};

test('Review fails a draft, a caller without needs, and a needed job that did not succeed', async () => {
  assert.match((await run({pull: {draft: true}})).failures[0], /draft/);
  for (const needs of [null, {}]) assert.match((await run({needs})).failures[0], /needs the jobs/);
  for (const result of ['failure', 'cancelled', 'skipped']) {
    const {failures} = await run({needs: {check: {result: 'success'}, test: {result}}});
    assert.match(failures[0], new RegExp(`test \\(${result}\\)`));
  }
});

test('Review waits for the previews of the head and fails on a failed or missing one', async () => {
  const pending = [{context: preview, state: 'pending'}];
  const passed = await run({previews: [preview], statuses: [[], pending, [{context: preview, state: 'success'}]]});
  assert.deepEqual(passed.failures, []);
  assert.equal(passed.polls, 3);
  const failed = await run({previews: [preview], statuses: [pending, [{context: preview, state: 'failure'}]]});
  assert.match(failed.failures[0], /Preview failed/);
  const missing = await run({previews: [preview], statuses: [pending]});
  assert.match(missing.failures[0], /did not finish within 1 minutes/);
});

test('Review stops waiting once the PR moved on, so the newer run is not held up', async () => {
  const pending = [[{context: preview, state: 'pending'}]];
  for (const current of [{head: {sha: 'newer'}}, {draft: true}, {state: 'closed'}]) {
    const stopped = await run({previews: [preview], statuses: pending, current});
    assert.match(stopped.failures[0], /newer run reviews it/);
    assert.equal(stopped.polls, 1);
  }
  // Without `pull-requests: read`, Review waits for the previews as before.
  const unreadable = await run({previews: [preview], statuses: [...pending, [{context: preview, state: 'success'}]], unreadable: true});
  assert.deepEqual(unreadable.failures, []);
  // A retargeted PR starts no new run, so Review keeps waiting.
  const retargeted = await run({previews: [preview], statuses: pending, current: {base: {ref: 'other'}}});
  assert.match(retargeted.failures[0], /did not finish within 1 minutes/);
});

test('Review turns on auto-merge only for a passed CloudCannon publication from the same repository', async () => {
  assert.deepEqual((await run({pull: cloudcannon})).merges, [{id: 'PR1', sha: 'head'}]);
  assert.deepEqual((await run({pull: cloudcannon, autoMerge: {merge_method: 'merge'}})).merges, []);
  for (const pull of [{}, {...cloudcannon, head: {...cloudcannon.head, repo: {full_name: 'fork/r'}}}]) {
    assert.deepEqual((await run({pull})).merges, []);
  }
  assert.deepEqual((await run({pull: cloudcannon, needs: {check: {result: 'failure'}}})).merges, []);
  assert.match((await run({pull: cloudcannon, refuse: 'Auto merge is not allowed'})).failures[0], /would not merge/);
  assert.match((await run({pull: cloudcannon, autoMerge: {merge_method: 'squash'}})).failures[0], /merge commit/);
  for (const current of [{head: {sha: 'newer'}}, {base: {ref: 'other'}}, {draft: true}, {state: 'closed'}]) {
    const changed = await run({pull: cloudcannon, current});
    assert.deepEqual(changed.merges, []);
    assert.match(changed.failures[0], /changed while Review waited/);
  }
});
