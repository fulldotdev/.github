import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import test from 'node:test';

const dependabot = createRequire(import.meta.url)('../.github/actions/dependabot/dependabot.cjs');

// A real security-group commit message (fulldotdev/thegymharen#69), with a quoted scoped name.
const real = readFileSync(new URL('./fixtures/dependabot-security-group.txt', import.meta.url), 'utf8');

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
const signed = msg => ({login: 'dependabot[bot]', committer: 'web-flow', verified: true, message: msg});

// One run against a canned PR: returns notices, failures and the auto-merge calls.
async function run({pull = {}, rules = ['Check / Check', 'Review'], commits = [signed(minor)],
  files = ['package.json', 'pnpm-lock.yaml'], current = {}, refuse, defaultBranch = 'main'} = {}) {
  const notices = [];
  const failures = [];
  const calls = [];
  const merges = [];
  const github = {
    rest: {
      repos: {getBranchRules: async () => ({data: rules === null ? [] : [{type: 'pull_request'},
        {type: 'required_status_checks', parameters: {required_status_checks: rules.map(context => ({context}))}}]})},
      pulls: {
        listCommits: async () => ({data: commits.map(commit => ({author: {login: commit.login}, committer: {login: commit.committer},
          commit: {message: commit.message, verification: {verified: commit.verified}}}))}),
        listFiles: 'listFiles',
        get: async () => ({data: {state: 'open', draft: false, head: {sha: 'head'}, auto_merge: null, ...current}}),
        merge: async args => { merges.push(args); },
      },
    },
    paginate: async method => {
      assert.equal(method, 'listFiles');
      return files.map(filename => ({filename}));
    },
    graphql: async (query, variables) => {
      if (/disablePullRequestAutoMerge/.test(query)) return calls.push(['off', variables.id]);
      if (refuse) throw new Error(refuse);
      assert.match(query, /mergeMethod: SQUASH/);
      calls.push(['on', variables.id, variables.sha]);
    },
  };
  await dependabot({
    github,
    context: {repo: {owner: 'o', repo: 'r'}, payload: {repository: {default_branch: defaultBranch}, pull_request: {
      number: 1, node_id: 'PR1', user: {login: 'dependabot[bot]'},
      head: {sha: 'head', ref: 'dependabot/npm_and_yarn/security-1', repo: {full_name: 'o/r'}}, base: {ref: 'main'}, ...pull}}},
    core: {notice: message => notices.push(message), info: () => {}, setFailed: message => failures.push(message)},
  });
  return {notices, failures, calls, merges};
}

test('a change is patch, minor or major, and below 1.0 or unreadable it counts as major', () => {
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

test('updates read every named dependency, quoted scoped names included', () => {
  const list = dependabot.updates(real);
  assert.equal(list.length, 11);
  assert.deepEqual(list.find(update => update.name === '@hono/node-server'), {name: '@hono/node-server', change: 'patch'});
  assert.deepEqual(list.find(update => update.name === 'astro'), {name: 'astro', change: 'minor'});
  assert.ok(list.every(update => update.change !== 'major'));
  const single = message(['Bumps [astro](https://github.com/withastro/astro) from 5.15.7 to 7.4.7.'], ['astro']);
  assert.deepEqual(dependabot.updates(single), [{name: 'astro', change: 'major'}]);
  // A dependency without its versions in the message counts as major.
  assert.deepEqual(dependabot.updates(message(['Updates `qs` from 6.16.0 to 6.17.1'], ['qs', 'hono'])),
    [{name: 'qs', change: 'minor'}, {name: 'hono', change: 'major'}]);
});

test('a Dependabot npm PR with routine updates gets squash auto-merge, the real commit too', async () => {
  for (const commits of [[signed(minor)], [signed(real)]]) {
    const {notices, failures, calls} = await run({commits});
    assert.deepEqual([notices, failures], [[], []]);
    assert.deepEqual(calls, [['on', 'PR1', 'head']]);
  }
});

test('without both required checks, nothing merges, because auto-merge would merge at once', async () => {
  for (const rules of [null, ['Check / Check'], ['Review']]) {
    const {notices, calls} = await run({rules});
    assert.match(notices[0], /does not require/);
    assert.deepEqual(calls, []);
  }
});

test('a major update, someone else\'s or unsigned commit, a .github change or another ecosystem stays for a person', async () => {
  const major = message(['Updates `astro` from 5.15.7 to 7.4.7', 'Updates `qs` from 6.16.0 to 6.17.1'], ['astro', 'qs']);
  const cases = [
    [{commits: [signed(major)]}, /major update: astro/],
    [{commits: [signed(minor), {...signed('Fix'), login: 'silveltman'}]}, /not Dependabot's signed commits/],
    [{commits: [{...signed(minor), committer: 'silveltman', verified: false}]}, /not Dependabot's signed commits/],
    [{commits: [{...signed(minor), verified: false}]}, /not Dependabot's signed commits/],
    [{files: ['package.json', '.github/workflows/check.yml']}, /changes \.github/],
    [{pull: {head: {sha: 'head', ref: 'dependabot/github_actions/x', repo: {full_name: 'o/r'}}}}, /only npm updates/],
    [{pull: {user: {login: 'someone'}}}, /not a Dependabot PR/],
    [{pull: {head: {sha: 'head', ref: 'dependabot/npm_and_yarn/x', repo: {full_name: 'fork/r'}}}}, /not in this repository/],
    [{pull: {base: {ref: 'other'}}}, /default branch/],
    [{current: {draft: true}}, /draft/],
    [{commits: [signed('Bump things')]}, /names no updates/],
    [{current: {head: {sha: 'newer'}}}, /newer run decides/],
  ];
  for (const [options, reason] of cases) {
    const {notices, calls, merges} = await run(options);
    assert.match(notices[0], reason);
    assert.deepEqual([calls, merges], [[], []]);
  }
});

test('each run turns earlier auto-merge off first and back on only while the head qualifies', async () => {
  const on = {auto_merge: {merge_method: 'squash'}};
  assert.deepEqual((await run({current: on})).calls, [['off', 'PR1'], ['on', 'PR1', 'head']]);
  const major = message(['Updates `astro` from 5.15.7 to 7.4.7'], ['astro']);
  for (const options of [{commits: [signed(major)]}, {commits: [signed(minor), {...signed('Fix'), login: 'silveltman'}]},
    {current: {...on, head: {sha: 'newer'}}}]) {
    assert.deepEqual((await run({current: on, ...options})).calls, [['off', 'PR1']]);
  }
});

test('a PR that can already merge merges now, and any other refusal fails', async () => {
  const clean = await run({refuse: 'Pull request is in clean status'});
  assert.deepEqual(clean.merges, [{owner: 'o', repo: 'r', pull_number: 1, sha: 'head', merge_method: 'squash'}]);
  const refused = await run({refuse: 'Auto merge is not allowed for this repository'});
  assert.match(refused.failures[0], /could not be turned on: Auto merge is not allowed/);
});
