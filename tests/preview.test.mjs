import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import test from 'node:test';
import {execFileSync, spawnSync} from 'node:child_process';

const source = readFileSync(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8')
  .split('          script: |\n')[1].split('\n  web:')[0]
  .split('\n').map(line => line.slice(12)).join('\n');
const execute = new (Object.getPrototypeOf(async function () {}).constructor)(
  'github', 'context', 'core', 'process', 'Date', 'setTimeout', 'require', 'fetch', source);

const recheckSource = readFileSync(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8')
  .split('      - name: Confirm the PR still matches the tested revision\n')[1]
  .split('          script: |\n')[1].split('\n      - name: HTTP tests')[0]
  .split('\n').map(line => line.slice(12)).join('\n');
const recheck = new (Object.getPrototypeOf(async function () {}).constructor)(
  'github', 'context', 'process', 'fetch', recheckSource);

test('URL tests reject a PR changed while the Web job waited for its lock', async () => {
  const pull = {number: 7, state: 'open', draft: false, head: {sha: 'tested-head'}};
  const context = {repo: {owner: 'o', repo: 'r'}, payload: {pull_request: pull}};
  const github = current => ({rest: {pulls: {get: async () => ({data: current})}}});
  await recheck(github(pull), context, {env: {}});
  for (const changes of [{draft: true}, {state: 'closed'}, {head: {sha: 'new-head'}}]) {
    await assert.rejects(() => recheck(github({...pull, ...changes}), context, {env: {}}), /PR changed/);
  }
});

test('URL tests revalidate approved alias and production revisions after waiting for the Web lock', async () => {
  const pull = {number: 7, state: 'open', draft: false, head: {sha: 'tested-head'}};
  const context = {repo: {owner: 'o', repo: 'r'}, payload: {pull_request: pull}};
  const github = {rest: {pulls: {get: async () => ({data: pull})}}};
  for (const origin of ['https://deploy-preview-7--site.netlify.app', 'https://site.test']) {
    const env = {DEPLOY_REVISIONS: JSON.stringify({[origin]: 'approved-revision'})};
    const fetchRevision = revision => async () => ({ok: true, json: async () => ({revision})});
    await recheck(github, context, {env}, fetchRevision('approved-revision'));
    await assert.rejects(() => recheck(github, context, {env}, fetchRevision('another-revision')), /changed while Web waited/);
  }
});

async function scenario(options = {}) {
  const pull = {number: 7, state: 'open', draft: false, head: {sha: options.head ?? 'tested-head'}, base: {sha: options.base}};
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
    {env: {...process.env, PREVIEW_CHECKS: JSON.stringify(names), DEPLOYMENTS: JSON.stringify(options.targets ?? []), GITHUB_WORKSPACE: options.root}},
    {now: () => clock}, callback => { clock += 60 * 1000; callback(); },
    createRequire(import.meta.url), async url => ({ok: !options.missingMarker,
      json: async () => ({revision: options.revisions?.[new URL(url).origin] ?? pull.head.sha})}));
  return {outputs, refs};
}

test('URL tests use previews associated with the exact PR head', async () => {
  const {outputs, refs} = await scenario({names: ['netlify/app/deploy-preview', 'netlify/site/deploy-preview']});
  assert.deepEqual(refs, ['tested-head']);
  assert.equal(outputs.sha, 'tested-head');
  assert.equal(outputs['base-url'], 'https://deploy-preview-7--app.netlify.app');
  assert.equal(Object.keys(JSON.parse(outputs['deploy-urls'])).length, 2);
  assert.deepEqual(JSON.parse(outputs['deploy-revisions']), {
    'https://deploy-preview-7--app.netlify.app': 'tested-head',
    'https://deploy-preview-7--site.netlify.app': 'tested-head',
  });
});

test('single-site previews require the served build to match the PR head', async () => {
  await assert.rejects(scenario({revisions: {[appAlias]: 'another-head'}}), /within 12 minutes/);
  await assert.rejects(scenario({missingMarker: true}), /within 12 minutes/);
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

// Real git history and native ignore commands protect selection and reuse from
// drifting apart. Nothing from the fixture is published or installed.
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'qa-preview-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const git = (...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  const write = (path, value) => {
    mkdirSync(join(root, path, '..'), {recursive: true});
    writeFileSync(join(root, path), value);
  };
  const commit = (path, value) => {
    if (path) write(path, value);
    git('add', '.');
    git('-c', 'user.name=QA', '-c', 'user.email=qa@example.test', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q');
  const targets = ['app', 'site'].map(site => {
    const paths = site === 'app' ? '. ../../packages/shared ../../root.json' : 'apps/site packages/shared root.json';
    write(`apps/${site}/netlify.toml`, `[build]\nignore = 'test -n "$CACHED_COMMIT_REF" && test "$CACHED_COMMIT_REF" != "$COMMIT_REF" && git diff --quiet "$CACHED_COMMIT_REF" "$COMMIT_REF" -- ${paths}'\n`);
    write(`apps/${site}/source.txt`, 'original');
    return {context: `netlify/${site}/deploy-preview`, config: `apps/${site}/netlify.toml`, url: `https://${site}.test`, ...(site === 'site' ? {'production-fallback': true} : {base: 'apps/app'})};
  });
  write('packages/shared/source.txt', 'shared');
  const base = commit();
  return {root, targets, names: targets.map(site => site.context), base, write, commit};
}

const skipped = context => ({context, state: 'success', target_url: 'https://app.netlify.com/sites/example/deploys/canceled'});
const appAlias = 'https://deploy-preview-7--app.netlify.app';
const siteAlias = 'https://deploy-preview-7--site.netlify.app';

test('native ignore rules select the changed site and shared dependents', async t => {
  const f = fixture(t);
  let head = f.commit('apps/site/source.txt', 'website changed');
  const result = await scenario({...f, head});
  assert.deepEqual(Object.keys(JSON.parse(result.outputs['deploy-urls'])), ['netlify/site/deploy-preview']);
  head = f.commit('packages/shared/source.txt', 'shared changed');
  const shared = await scenario({...f, head});
  assert.equal(Object.keys(JSON.parse(shared.outputs['deploy-urls'])).length, 2);
});

test('renaming across project folders and deleting source keeps both affected sites selected', async t => {
  const f = fixture(t);
  rmSync(join(f.root, 'apps/app/source.txt'));
  const head = f.commit('apps/site/moved.txt', 'original');
  assert.equal(Object.keys(JSON.parse((await scenario({...f, head})).outputs['deploy-urls'])).length, 2);
});

test('a later unrelated push still tests the cumulative PR change on a proven unchanged preview', async t => {
  const f = fixture(t);
  const revision = f.commit('apps/app/source.txt', 'app changed');
  const head = f.commit('README.md', 'later unrelated push');
  const result = await scenario({...f, head, statuses: [skipped('netlify/app/deploy-preview')], revisions: {[appAlias]: revision}});
  assert.deepEqual(JSON.parse(result.outputs['deploy-urls']), {'netlify/app/deploy-preview': appAlias});
});

test('a skipped or manually canceled changed app cannot reuse stale code or production', async t => {
  const f = fixture(t);
  const head = f.commit('apps/app/source.txt', 'app changed');
  await assert.rejects(scenario({...f, head, statuses: [skipped('netlify/app/deploy-preview')], revisions: {[appAlias]: f.base}}), /within 12 minutes/);
  await assert.rejects(scenario({...f, head, revisions: {[appAlias]: f.base}}), /within 12 minutes/);
});

test('only explicitly read-only sites may reuse matching production when no first preview exists', async t => {
  const f = fixture(t);
  const revision = f.commit('apps/site/source.txt', 'site changed');
  const head = f.commit('README.md', 'later unrelated push');
  const options = {...f, head, statuses: [skipped('netlify/site/deploy-preview')], revisions: {[siteAlias]: 'missing', 'https://site.test': revision}};
  const result = await scenario(options);
  assert.equal(JSON.parse(result.outputs['deploy-urls'])['netlify/site/deploy-preview'], 'https://site.test');
  await assert.rejects(scenario({...options, targets: f.targets.map(site => ({...site, 'production-fallback': false}))}), /within 12 minutes/);
});

test('changed tests exercise all targets and missing baselines fail safe to every target', async t => {
  const f = fixture(t);
  const head = f.commit('tests/http/example.spec.ts', 'new test');
  assert.equal(Object.keys(JSON.parse((await scenario({...f, head})).outputs['deploy-urls'])).length, 2);
  assert.equal(Object.keys(JSON.parse((await scenario({...f, head, base: 'missing-base'})).outputs['deploy-urls'])).length, 2);
});

test('an explicit empty scope skips URL work without waiting for unused statuses', async t => {
  const f = fixture(t);
  const head = f.commit('README.md', 'documentation only');
  const result = await scenario({...f, head, statuses: []});
  assert.equal(result.outputs['web-enabled'], 'false');
  assert.equal(result.outputs['deploy-urls'], '{}');
  assert.deepEqual(result.refs, []);
});

test('native ignore failures cannot silently remove a target from required tests', async t => {
  const f = fixture(t);
  const head = f.commit('apps/app/netlify.toml', "[build]\nignore = 'exit 2'\n");
  await assert.rejects(scenario({...f, head}), /build.ignore failed/);
});

// Exercise the actual aggregate with upstream outcomes: skipped prerequisites
// must never turn an enabled URL suite into a successful merge gate.
const gate = readFileSync(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8')
  .split('      - name: Require every enabled category\n')[1].split('        run: |\n')[1]
  .split('\n').map(line => line.slice(10)).join('\n');
function aggregate(overrides = {}) {
  return spawnSync('bash', ['-e', '-c', gate], {env: {...process.env,
    UNIT_ENABLED: 'false', WEB_ENABLED: 'true', UNIT_RESULT: 'skipped',
    PREVIEW_RESULT: 'success', WEB_RESULT: 'success', WEB_SELECTED: 'true', ...overrides}}).status;
}
test('enabled URL tests require successful preview and Web jobs', () => {
  assert.equal(aggregate(), 0);
  for (const result of ['skipped', 'failure', 'cancelled']) {
    assert.notEqual(aggregate({PREVIEW_RESULT: result}), 0);
    assert.notEqual(aggregate({WEB_RESULT: result}), 0);
  }
  assert.equal(aggregate({WEB_ENABLED: 'false', PREVIEW_RESULT: 'skipped', WEB_RESULT: 'skipped'}), 0);
  assert.equal(aggregate({WEB_SELECTED: 'false', WEB_RESULT: 'skipped'}), 0);
  assert.notEqual(aggregate({WEB_SELECTED: '', WEB_RESULT: 'skipped'}), 0);
  assert.notEqual(aggregate({UNIT_ENABLED: 'true'}), 0);
});
