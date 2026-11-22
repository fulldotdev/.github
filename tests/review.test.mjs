import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import test from 'node:test';

const review = createRequire(import.meta.url)('../.github/actions/review/review.cjs');

// One Review run against canned statuses: `statuses` gives the head's
// statuses per poll, the last one repeating.
async function run({needs = {check: {result: 'success'}}, previews = [], statuses = [[]], pull = {}, merge = {ok: true, body: {}}} = {}) {
  const failures = [];
  const errors = [];
  const merges = [];
  let polls = 0;
  let clock = 0;
  const github = {rest: {repos: {getCombinedStatusForRef: async ({ref}) => {
    assert.equal(ref, 'head');
    return {data: {statuses: statuses[Math.min(polls++, statuses.length - 1)]}};
  }}}};
  const fetch = async (url, {headers, body}) => {
    merges.push({token: headers.Authorization, ...JSON.parse(body).variables});
    return {ok: merge.ok, status: merge.ok ? 200 : 403, json: async () => merge.body};
  };
  await review({
    github,
    context: {repo: {owner: 'o', repo: 'r'}, payload: {pull_request: {node_id: 'PR1', head: {sha: 'head', ref: 'feature', repo: {full_name: 'o/r'}},
      user: {login: 'someone'}, ...pull}}},
    core: {setFailed: message => failures.push(message), error: message => errors.push(message), info: () => {}},
    env: {NEEDS: JSON.stringify(needs), NETLIFY_CHECKS: JSON.stringify(previews), TIMEOUT_MINUTES: '1', MERGE_TOKEN: 'merge-token'},
    fetch,
    sleep: async ms => { clock += ms; },
    now: () => clock,
  });
  return {failures, errors, merges, polls};
}

const preview = 'netlify/site/deploy-preview';
const cloudcannon = {user: {login: 'cloudcannon[bot]'}, head: {sha: 'head', ref: 'preview', repo: {full_name: 'o/r'}}};

test('Review fails when a needed job failed, was cancelled or was skipped', async () => {
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

test('Review turns on auto-merge only for a passed CloudCannon publication from the same repository', async () => {
  const published = await run({pull: cloudcannon});
  assert.deepEqual(published.merges, [{token: 'Bearer merge-token', id: 'PR1', sha: 'head'}]);
  for (const pull of [{}, {...cloudcannon, head: {...cloudcannon.head, repo: {full_name: 'fork/r'}}}]) {
    assert.deepEqual((await run({pull})).merges, []);
  }
  assert.deepEqual((await run({pull: cloudcannon, needs: {check: {result: 'failure'}}})).merges, []);
  const refused = await run({pull: cloudcannon, merge: {ok: false, body: {}}});
  assert.deepEqual(refused.failures, []);
  assert.match(refused.errors[0], /Auto-merge could not be turned on/);
});
