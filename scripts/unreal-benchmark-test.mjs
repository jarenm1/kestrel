// Synthetic fixture: this exercises orchestration, not Unreal or rendering.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const root = mkdtempSync(join(tmpdir(), 'unreal-bench-test-'));
try {
  const dirs = ['engine', 'workspaceA', 'workspaceB', 'localCacheA', 'localCacheB', 'sharedCache', 'output'];
  const paths = Object.fromEntries(dirs.map(x => [x, join(root, x)]));
  for (const path of Object.values(paths)) mkdirSync(path);
  const git = (cwd, args) => { const p = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(p.status, 0, p.stderr); };
  git(paths.workspaceA, ['init', '-q']);
  git(paths.workspaceA, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture']);
  git(root, ['clone', '-q', paths.workspaceA, paths.workspaceB]);
  const config = { version: 1, disposable: true, synthetic: true, engineIdentity: 'synthetic fixture', zenUrl: 'http://fixture.invalid:8558', timeoutSeconds: 5, ...paths, argv: [process.execPath, '-e', 'console.log(process.argv[1])', '{workspace}'] };
  const file = join(root, 'config.json'); writeFileSync(file, JSON.stringify(config));
  const runner = resolve('scripts/unreal-benchmark.mjs');
  let p = spawnSync(process.execPath, [runner, file, '--dry-run'], { encoding: 'utf8' }); assert.equal(p.status, 0, p.stderr); assert.equal(JSON.parse(p.stdout).runs.length, 3);
  p = spawnSync(process.execPath, [runner, file], { encoding: 'utf8' }); assert.equal(p.status, 0, p.stderr);
  const result = JSON.parse(readFileSync(join(paths.output, 'result.json'))); assert.deepEqual(result.runs.map(x => x.exitCode), [0, 0, 0]); assert.equal(result.cacheEvidence, 'unknown'); assert.equal(result.synthetic, true);
  p = spawnSync(process.execPath, [runner, file], { encoding: 'utf8' }); assert.notEqual(p.status, 0);
  console.log('synthetic benchmark fixture passed');
} finally { rmSync(root, { recursive: true, force: true }); }
