import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import test from 'node:test';

const dependabot = createRequire(import.meta.url)('../.github/actions/dependabot/dependabot.cjs');

const message = (lines, names) => [
  'Bump the security group across 1 directory with 2 updates',
  '',
  ...lines,
  '',
  '---',
  'updated-dependencies:',
  ...names.flatMap(name => [`- dependency-name: ${name}`, '  dependency-version: 1.0.0', '  dependency-type: indirect', '  dependency-group: security']),
  '...',
].join('\n');
const minor = message(['Updates `qs` from 6.16.0 to 6.17.1', 'Updates `undici` from 7.30.0 to 7.30.2'], ['qs', 'undici']);

// One run against a canned PR: returns notices, failures and what it merged.
async function run({pull = {}, rules = ['Check / Check', 'Review'], commits = [{login: 'dependabot[bot]', message: minor}],
  files = ['package.json', 'pnpm-lock.yaml'], current = {}, refuse, defaultBranch = 'main'} = {}) {
  const notices = [];
  const failures = [];
  const autoMerges = [];
  const merges = [];
  const disabled = [];
  const github = {
    rest: {
      repos: {getBranchRules: async () => ({data: rules === null ? [] : [{type: 'pull_request'},
        {type: 'required_status_checks', parameters: {required_status_checks: rules.map(context => ({context}))}}]})},
      pulls: {
        listCommits: async () => ({data: commits.map(commit => ({author: {login: commit.login}, commit: {message: commit.message}}))}),
        listFiles: 'listFiles',
        get: async () => ({data: {state: 'open', head: {sha: 'head'}, auto_merge: null, ...current}}),
        merge: async args => { merges.push(args); },
      },
    },
    paginate: async method => {
      assert.equal(method, 'listFiles');
      return files.map(filename => ({filename}));
    },
    graphql: async (query, variables) => {
      if (/disablePullRequestAutoMerge/.test(query)) return disabled.push(variables);
      if (refuse) throw new Error(refuse);
      assert.match(query, /mergeMethod: SQUASH/);
      autoMerges.push(variables);
    },
  };
  await dependabot({
    github,
    context: {repo: {owner: 'o', repo: 'r'}, payload: {repository: {default_branch: defaultBranch}, pull_request: {
      number: 1, node_id: 'PR1', draft: false, state: 'open', user: {login: 'dependabot[bot]'},
      head: {sha: 'head', ref: 'dependabot/npm_and_yarn/security-1', repo: {full_name: 'o/r'}}, base: {ref: 'main'}, ...pull}}},
    core: {notice: message => notices.push(message), info: () => {}, setFailed: message => failures.push(message)},
  });
  return {notices, failures, autoMerges, merges, disabled};
}

test('a change is patch, minor or major, and below 1.0 or unreadable it is major', () => {
  assert.equal(dependabot.change('7.30.0', '7.30.2'), 'patch');
  assert.equal(dependabot.change('6.16.0', '6.17.1'), 'minor');
  assert.equal(dependabot.change('5.15.7', '7.4.7'), 'major');
  assert.equal(dependabot.change('0.2.3', '0.3.0'), 'major');
  assert.equal(dependabot.change('0.0.1', '0.0.2'), 'major');
  assert.equal(dependabot.change('0.2.3', '0.2.9'), 'patch');
  assert.equal(dependabot.change('1.0.0', '2.0.0-beta.2'), 'major');
  assert.equal(dependabot.change('v1.2.3', 'v1.3.0'), 'minor');
  assert.equal(dependabot.change('64ab729', 'f418cff'), 'major');
});

test('updates read every named dependency, from group and single-update commits', () => {
  assert.deepEqual(dependabot.updates(minor), [{name: 'qs', change: 'minor'}, {name: 'undici', change: 'patch'}]);
  const single = message(['Bumps [astro](https://github.com/withastro/astro) from 5.15.7 to 7.4.7.'], ['astro']);
  assert.deepEqual(dependabot.updates(single), [{name: 'astro', change: 'major'}]);
  // A dependency without its versions in the message counts as major.
  assert.deepEqual(dependabot.updates(message(['Updates `qs` from 6.16.0 to 6.17.1'], ['qs', 'hono'])),
    [{name: 'qs', change: 'minor'}, {name: 'hono', change: 'major'}]);
});

test('a Dependabot npm PR with patch and minor updates gets squash auto-merge', async () => {
  const {notices, failures, autoMerges} = await run();
  assert.deepEqual([notices, failures], [[], []]);
  assert.deepEqual(autoMerges, [{id: 'PR1', sha: 'head'}]);
});

test('without both required checks, nothing merges, because auto-merge would merge at once', async () => {
  for (const rules of [null, ['Check / Check'], ['Review']]) {
    const {notices, autoMerges} = await run({rules});
    assert.match(notices[0], /does not require/);
    assert.deepEqual(autoMerges, []);
  }
});

test('a major update, a person\'s commit, a .github change or another ecosystem stays for a person', async () => {
  const major = message(['Updates `astro` from 5.15.7 to 7.4.7', 'Updates `qs` from 6.16.0 to 6.17.1'], ['astro', 'qs']);
  const cases = [
    [{commits: [{login: 'dependabot[bot]', message: major}]}, /major update: astro/],
    [{commits: [{login: 'dependabot[bot]', message: minor}, {login: 'silveltman', message: 'Fix'}]}, /someone other than Dependabot/],
    [{files: ['package.json', '.github/workflows/check.yml']}, /changes \.github/],
    [{pull: {head: {sha: 'head', ref: 'dependabot/github_actions/x', repo: {full_name: 'o/r'}}}}, /only npm updates/],
    [{pull: {user: {login: 'someone'}}}, /not a Dependabot PR/],
    [{pull: {head: {sha: 'head', ref: 'dependabot/npm_and_yarn/x', repo: {full_name: 'fork/r'}}}}, /not in this repository/],
    [{pull: {base: {ref: 'other'}}}, /default branch/],
    [{current: {draft: true}}, /draft/],
    [{commits: [{login: 'dependabot[bot]', message: 'Bump things'}]}, /names no updates/],
    [{current: {head: {sha: 'newer'}}}, /newer run decides/],
  ];
  for (const [options, reason] of cases) {
    const {notices, autoMerges, merges} = await run(options);
    assert.match(notices[0], reason);
    assert.deepEqual([autoMerges, merges], [[], []]);
  }
});

test('a PR that no longer qualifies loses the auto-merge an earlier run turned on', async () => {
  const on = {auto_merge: {merge_method: 'squash'}};
  const pushed = await run({current: on, commits: [{login: 'dependabot[bot]', message: minor}, {login: 'silveltman', message: 'Fix'}]});
  assert.match(pushed.notices[0], /someone other than Dependabot\. Auto-merge is off again/);
  assert.deepEqual(pushed.disabled, [{id: 'PR1'}]);
  const major = message(['Updates `astro` from 5.15.7 to 7.4.7'], ['astro']);
  assert.deepEqual((await run({current: on, commits: [{login: 'dependabot[bot]', message: major}]})).disabled, [{id: 'PR1'}]);
  // Without auto-merge on, there is nothing to turn off.
  assert.deepEqual((await run({commits: [{login: 'dependabot[bot]', message: major}]})).disabled, []);
});

test('auto-merge that is on stays, a PR that can already merge merges now, and a refusal fails', async () => {
  assert.deepEqual((await run({current: {auto_merge: {merge_method: 'squash'}}})).autoMerges, []);
  const clean = await run({refuse: 'Pull request is in clean status'});
  assert.deepEqual(clean.merges, [{owner: 'o', repo: 'r', pull_number: 1, sha: 'head', merge_method: 'squash'}]);
  const refused = await run({refuse: 'Auto merge is not allowed for this repository'});
  assert.match(refused.failures[0], /could not be turned on: Auto merge is not allowed/);
});
