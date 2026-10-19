import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {execFileSync, spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

test('live credentials cannot reach a feature commit or an invalid revision', () => {
  const guard = readFileSync(new URL('../.github/workflows/test-live.yml', import.meta.url), 'utf8')
    .split('      - name: Confirm the revision belongs to the default branch\n')[1]
    .split('        run: |\n')[1].split('\n      - uses:')[0]
    .split('\n').map(line => line.slice(10)).join('\n');
  const cwd = mkdtempSync(join(tmpdir(), 'production-revision-'));
  const git = (...args) => execFileSync('git', args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  try {
    git('init', '--initial-branch=main');
    const commit = message => git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-m', message);
    commit('production');
    const main = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/remotes/origin/main', main);
    commit('unmerged feature');
    const feature = git('rev-parse', 'HEAD');
    const check = revision => spawnSync('bash', ['-e', '-o', 'pipefail', '-c', guard], {
      cwd, env: {...process.env, REVISION: revision, DEFAULT_BRANCH: 'main'}, encoding: 'utf8',
    });
    assert.equal(check(main).status, 0);
    assert.notEqual(check(feature).status, 0);
    assert.notEqual(check('HEAD').status, 0);
    assert.notEqual(check('invalid; exit 0').status, 0);
  } finally {
    rmSync(cwd, {recursive: true, force: true});
  }
});

const source = readFileSync(new URL('../.github/workflows/test-live.yml', import.meta.url), 'utf8')
  .split('      - name: Wait for the published production revision\n')[1]
  .split('        run: |\n')[1].split('\n      - name: Safe live HTTP smoke')[0]
  .split('\n').map(line => line.slice(10)).join('\n').split('deadline =')[0];

test('production waits for this revision and reuses the Netlify ignore decision for unchanged sites', () => {
  const result = spawnSync('python3', ['-c', `
import contextlib, io, json, os, tempfile
from types import SimpleNamespace
from unittest.mock import patch

os.environ['REVISION'] = 'a' * 40
os.environ['DEPLOYMENTS'] = '[{"url":"https://example.netlify.app"}]'
scope = {}
exec(${JSON.stringify(source)}, scope)
published = scope['published']
site = {'url': 'https://example.netlify.app'}

def response(revision):
    return contextlib.nullcontext(io.StringIO(json.dumps({'revision': revision})))

with patch('urllib.request.urlopen', return_value=response('a' * 40)), patch('subprocess.run') as run:
    assert published(site)
    run.assert_not_called()

for revision in [None, 'bad', '$(unsafe)', 'a' * 41]:
    with patch('urllib.request.urlopen', return_value=response(revision)), patch('subprocess.run') as run:
        assert not published(site)
        run.assert_not_called()

with patch('urllib.request.urlopen', side_effect=OSError('not deployed')):
    assert not published(site)

with tempfile.TemporaryDirectory() as directory:
    config = os.path.join(directory, 'netlify.toml')
    with open(config, 'w') as handle:
        handle.write("[build]\\nignore = 'git diff --quiet'\\n")
    target = {**site, 'config': config, 'base': directory}
    for code in [0, 1, 2]:
        with patch('urllib.request.urlopen', return_value=response('b' * 40)), patch('subprocess.run',
                side_effect=[SimpleNamespace(returncode=0), SimpleNamespace(returncode=code)]) as run:
            if code == 2:
                try:
                    published(target)
                    raise AssertionError('ignore errors cannot pass')
                except RuntimeError:
                    pass
            else:
                assert published(target) == (code == 0)
            assert run.call_args.kwargs['cwd'] == directory
            assert run.call_args.kwargs['env']['CACHED_COMMIT_REF'] == 'b' * 40
            assert run.call_args.kwargs['env']['COMMIT_REF'] == 'a' * 40
    with patch('urllib.request.urlopen', return_value=response('c' * 40)), patch('subprocess.run',
            return_value=SimpleNamespace(returncode=1)) as run:
        assert not published(target)
        assert run.call_count == 1
`], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
