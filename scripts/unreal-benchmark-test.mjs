// Synthetic fixture: this exercises orchestration, not Unreal or rendering.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = mkdtempSync(join(tmpdir(), 'unreal-bench-test-'));
const dirs = ['engine', 'workspaceA', 'workspaceB', 'localCacheA', 'localCacheB', 'sharedCache', 'output'];
const paths = Object.fromEntries(dirs.map(x => [x, join(root, x)]));
for (const path of Object.values(paths)) mkdirSync(path);
const git = (cwd, args) => { const p = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(p.status, 0, p.stderr); };
git(paths.workspaceA, ['init', '-q']);
git(paths.workspaceA, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture']);
git(root, ['clone', '-q', paths.workspaceA, paths.workspaceB]);

const runner = resolve('scripts/unreal-benchmark.mjs');
const configFile = join(root, 'config.json');
const base = {
  version: 1, disposable: true, synthetic: true, engineIdentity: 'synthetic fixture',
  zenUrl: 'http://fixture.invalid:8558', timeoutSeconds: 5, ...paths,
  argv: [process.execPath, '-e', 'console.log(process.argv[1])', '{workspace}']
};
const clearDisposableDirs = () => {
  for (const key of ['localCacheA', 'localCacheB', 'sharedCache', 'output'])
    for (const name of readdirSync(paths[key])) rmSync(join(paths[key], name), { recursive: true, force: true });
};
const invoke = (overrides = {}, flags = []) => {
  clearDisposableDirs();
  writeFileSync(configFile, JSON.stringify({ ...base, ...overrides }));
  return spawnSync(process.execPath, [runner, configFile, ...flags], { encoding: 'utf8' });
};
const rejected = (p, pattern) => {
  assert.notEqual(p.status, 0, 'expected the runner to reject this configuration');
  assert.match(p.stderr, pattern);
};
const waitFor = async (path, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(existsSync(path), `timed out waiting for ${path}`);
};

try {
  // Planned run: the JSON is emitted and the phases are described without touching a cache.
  let p = invoke({}, ['--dry-run']);
  assert.equal(p.status, 0, p.stderr);
  const planned = JSON.parse(p.stdout);
  assert.equal(planned.runs.length, 3);
  assert.equal(planned.cacheEvidence, 'unknown');
  assert.equal(planned.coldCache.status, 'not-run');
  assert.equal(planned.diskMeasurement.measured, false);
  assert.ok(planned.runs.every(x => x.remoteCacheState === 'unverified'));

  // Successful synthetic sequence: local disk is measured, remote cache state stays unattested.
  p = invoke();
  assert.equal(p.status, 0, p.stderr);
  const result = JSON.parse(readFileSync(join(paths.output, 'result.json')));
  assert.deepEqual(result.runs.map(x => x.exitCode), [0, 0, 0]);
  assert.equal(result.cacheEvidence, 'unknown');
  assert.equal(result.synthetic, true);
  assert.equal(result.coldCache.status, 'not-attested');
  assert.equal(result.diskMeasurement.measured, true);
  assert.ok(result.runs.every(x => x.remoteCacheState === 'unverified'));
  assert.ok(result.runs.every(x => Array.isArray(x.diskBytes) && x.diskBytes.length === 2));
  assert.match(readFileSync(join(paths.output, 'a-cold.log'), 'utf8'), /cold|remote/i);
  assert.equal(result.interrupted, false);

  // A used output directory is not disposable any more.
  p = spawnSync(process.execPath, [runner, configFile], { encoding: 'utf8' });
  rejected(p, /output must be an empty disposable directory/);

  // Overlapping paths are rejected before anything runs.
  rejected(invoke({ localCacheA: paths.workspaceA }), /paths must be disjoint/);

  // A workspace with uncommitted changes is rejected.
  const dirty = join(paths.workspaceA, 'untracked.txt');
  writeFileSync(dirty, 'dirty');
  try {
    rejected(invoke(), /workspace must be clean/);
  } finally {
    rmSync(dirty);
  }

  // NullRHI cannot produce rendering evidence.
  rejected(invoke({ argv: [process.execPath, '-e', '0', '-nullrhi'] }), /NullRHI/);

  // A hanging child is killed at the timeout and the sequence stops with a failed result.
  p = invoke({ timeoutSeconds: 0.5, argv: [process.execPath, '-e', 'setTimeout(() => {}, 60000)'] });
  assert.notEqual(p.status, 0);
  const timed = JSON.parse(readFileSync(join(paths.output, 'result.json')));
  assert.equal(timed.runs.length, 1);
  assert.equal(timed.runs[0].timedOut, true);
  assert.equal(timed.runs[0].signal, 'SIGKILL');
  assert.ok(timed.runs[0].durationMs < 10000, 'timeout should terminate the child promptly');

  // SIGINT stops the current process group, marks the result and skips the remaining phases.
  clearDisposableDirs();
  writeFileSync(configFile, JSON.stringify({ ...base, timeoutSeconds: 60, argv: [process.execPath, '-e', 'setTimeout(() => {}, 60000)'] }));
  const runnerChild = spawn(process.execPath, [runner, configFile], { stdio: 'ignore' });
  const exit = new Promise(resolve => runnerChild.once('exit', (code, signal) => resolve({ code, signal })));
  await waitFor(join(paths.output, 'a-cold.log'));
  runnerChild.kill('SIGINT');
  const outcome = await exit;
  assert.equal(outcome.code, 1);
  const interrupted = JSON.parse(readFileSync(join(paths.output, 'result.json')));
  assert.equal(interrupted.interrupted, true);
  assert.equal(interrupted.interruptSignal, 'SIGINT');
  assert.equal(interrupted.runs.length, 1, 'no later phase may start after SIGINT');
  assert.equal(interrupted.runs[0].interrupted, true);

  console.log('synthetic benchmark fixture passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
