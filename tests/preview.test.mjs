import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8')
  .split('          script: |\n')[1].split('\n      - name: HTTP tests')[0]
  .split('\n').map(line => line.slice(12)).join('\n');
const execute = new (Object.getPrototypeOf(async function () {}).constructor)(
  'github', 'context', 'core', 'process', 'Date', 'setTimeout', source);

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
