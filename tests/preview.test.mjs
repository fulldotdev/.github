import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {spawnSync} from 'node:child_process';

const source = readFileSync(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8')
  .split('          script: |\n')[1].split('\n  web:')[0]
  .split('\n').map(line => line.slice(12)).join('\n');
const execute = new (Object.getPrototypeOf(async function () {}).constructor)(
  'github', 'context', 'core', 'process', 'Date', 'setTimeout', source);

const recheckSource = readFileSync(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8')
  .split('      - name: Confirm the PR still matches the tested revision\n')[1]
  .split('          script: |\n')[1].split('\n      - name: HTTP tests')[0]
  .split('\n').map(line => line.slice(12)).join('\n');
const recheck = new (Object.getPrototypeOf(async function () {}).constructor)(
  'github', 'context', recheckSource);

test('URL tests reject a PR changed while the Web job waited for its lock', async () => {
  const pull = {number: 7, state: 'open', draft: false, head: {sha: 'tested-head'}};
  const context = {repo: {owner: 'o', repo: 'r'}, payload: {pull_request: pull}};
  const github = current => ({rest: {pulls: {get: async () => ({data: current})}}});
  await recheck(github(pull), context);
  for (const changes of [{draft: true}, {state: 'closed'}, {head: {sha: 'new-head'}}]) {
    await assert.rejects(() => recheck(github({...pull, ...changes}), context), /PR changed/);
  }
});

async function scenario(options = {}) {
  const pull = {number: 7, state: 'open', draft: false, head: {sha: 'tested-head'}};
  const names = options.names ?? ['netlify/app/deploy-preview'];
  const outputs = {};
  const refs = [];
  let clock = 0;
  const github = {rest: {
    pulls: {get: async () => ({data: {...pull, ...options.current}})},
    repos: {getCombinedStatusForRef: async ({ref}) => {
      refs.push(ref);
      return {data: {statuses: options.statuses ?? names.map(context => ({context, state: 'success',
        target_url: `https://deploy-preview-7--${context.split('/')[1]}.netlify.app`}))}};
    }},
  }};
  await execute(github, {repo: {owner: 'o', repo: 'r'}, payload: {pull_request: pull}},
    {info() {}, setOutput: (name, value) => { outputs[name] = value; }},
    {env: {PREVIEW_CHECKS: JSON.stringify(names)}},
    {now: () => clock}, callback => { clock += 60 * 1000; callback(); });
  return {outputs, refs};
}

test('URL tests use previews associated with the exact PR head', async () => {
  const {outputs, refs} = await scenario({names: ['netlify/app/deploy-preview', 'netlify/site/deploy-preview']});
  assert.deepEqual(refs, ['tested-head']);
  assert.equal(outputs.sha, 'tested-head');
  assert.equal(outputs['base-url'], 'https://deploy-preview-7--app.netlify.app');
  assert.equal(Object.keys(JSON.parse(outputs['deploy-urls'])).length, 2);
});

test('failed, absent and pending previews cannot become passing URL tests', async () => {
  for (const state of ['failure', 'error']) {
    await assert.rejects(scenario({statuses: [{context: 'netlify/app/deploy-preview', state}]}), /failed/);
  }
  for (const statuses of [[], [{context: 'netlify/app/deploy-preview', state: 'pending'}]]) {
    await assert.rejects(scenario({statuses}), /within 12 minutes/);
  }
});

test('superseded, closed and draft PRs stop before testing', async () => {
  for (const current of [{head: {sha: 'new-head'}}, {state: 'closed'}, {draft: true}]) {
    await assert.rejects(scenario({current}), /PR changed or returned to draft/);
  }
});

test('production, another PR and untrusted URLs are rejected', async () => {
  for (const target_url of ['https://app.netlify.app', 'https://deploy-preview-8--app.netlify.app',
    'https://deploy-preview-7--another-site.netlify.app',
    'http://deploy-preview-7--app.netlify.app', 'https://deploy-preview-7--app.netlify.app.attacker.test',
    'https://user:password@deploy-preview-7--app.netlify.app']) {
    await assert.rejects(scenario({statuses: [{context: 'netlify/app/deploy-preview', state: 'success', target_url}]}),
      /did not return this PR/);
  }
  await assert.rejects(scenario({names: []}), /require preview-checks/);
});

// Exercise the actual aggregate with upstream outcomes: skipped prerequisites
// must never turn an enabled URL suite into a successful merge gate.
const gate = readFileSync(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8')
  .split('      - name: Require every enabled category\n')[1].split('        run: |\n')[1]
  .split('\n').map(line => line.slice(10)).join('\n');
function aggregate(overrides = {}) {
  return spawnSync('bash', ['-e', '-c', gate], {env: {...process.env,
    UNIT_ENABLED: 'false', WEB_ENABLED: 'true', UNIT_RESULT: 'skipped',
    PREVIEW_RESULT: 'success', WEB_RESULT: 'success', ...overrides}}).status;
}
test('enabled URL tests require successful preview and Web jobs', () => {
  assert.equal(aggregate(), 0);
  for (const result of ['skipped', 'failure', 'cancelled']) {
    assert.notEqual(aggregate({PREVIEW_RESULT: result}), 0);
    assert.notEqual(aggregate({WEB_RESULT: result}), 0);
  }
  assert.equal(aggregate({WEB_ENABLED: 'false', PREVIEW_RESULT: 'skipped', WEB_RESULT: 'skipped'}), 0);
  assert.notEqual(aggregate({UNIT_ENABLED: 'true'}), 0);
});
