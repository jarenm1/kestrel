#!/usr/bin/env node
// Runs only in operator-prepared disposable workspaces and caches. No shell is involved.
import { spawn, spawnSync } from 'node:child_process';
import { realpathSync, readdirSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { relative, join } from 'node:path';

const [configPath, ...flags] = process.argv.slice(2);
if (!configPath || flags.some(x => x !== '--dry-run')) throw Error('usage: node scripts/unreal-benchmark.mjs config.json [--dry-run]');
const c = JSON.parse(await (await import('node:fs/promises')).readFile(configPath, 'utf8'));
const dry = flags.includes('--dry-run');
if (c.version !== 1 || c.disposable !== true || !Array.isArray(c.argv) || !c.argv.length || !c.argv.every(x => typeof x === 'string') || !Number.isFinite(c.timeoutSeconds) || c.timeoutSeconds <= 0 || typeof c.engineIdentity !== 'string' || !c.engineIdentity || typeof c.zenUrl !== 'string' || !c.zenUrl) throw Error('invalid configuration; version, disposable acknowledgement, engineIdentity, zenUrl, argv and positive timeoutSeconds required');
if (c.argv.some(x => /nullrhi/i.test(x))) throw Error('NullRHI is not a rendering benchmark');
const paths = Object.fromEntries(['engine', 'workspaceA', 'workspaceB', 'localCacheA', 'localCacheB', 'sharedCache', 'output'].map(k => [k, realpathSync(c[k])]));
const keys = Object.keys(paths);
for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
  const a = paths[keys[i]], b = paths[keys[j]];
  if (!relative(a, b) || !relative(b, a) || (!relative(a, b).startsWith('..') && !relative(a, b).startsWith('/')) || (!relative(b, a).startsWith('..') && !relative(b, a).startsWith('/'))) throw Error(`paths must be disjoint: ${keys[i]}, ${keys[j]}`);
}
for (const k of ['localCacheA', 'localCacheB', 'sharedCache', 'output']) if (readdirSync(paths[k]).length) throw Error(`${k} must be an empty disposable directory`);
const revision = dir => {
  const p = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' });
  if (p.status !== 0) throw Error(`cannot determine project revision in ${dir}`);
  const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: dir, encoding: 'utf8' });
  if (status.status !== 0 || status.stdout.trim()) throw Error(`workspace must be clean: ${dir}`);
  return p.stdout.trim();
};
const revisions = [revision(paths.workspaceA), revision(paths.workspaceB)];
if (revisions[0] !== revisions[1]) throw Error('workspace revisions differ');
const expand = (arg, workspace, cache) => arg.replaceAll('{engine}', paths.engine).replaceAll('{workspace}', workspace).replaceAll('{localCache}', cache).replaceAll('{sharedCache}', paths.sharedCache).replaceAll('{zenUrl}', c.zenUrl);
const runs = [['a-cold', paths.workspaceA, paths.localCacheA], ['a-warm', paths.workspaceA, paths.localCacheA], ['b-shared-warm', paths.workspaceB, paths.localCacheB]];
const result = { version: 1, synthetic: c.synthetic === true, dryRun: dry, engineIdentity: c.engineIdentity, projectRevision: revisions[0], config: c, paths, cacheEvidence: 'unknown', runs: [] };
for (const [name, workspace, cache] of runs) {
  const argv = c.argv.map(x => expand(x, workspace, cache));
  const entry = { name, argv, cwd: workspace, durationMs: null, exitCode: null, signal: null, timedOut: false, diskBytes: null, resourceMetrics: 'unavailable' };
  result.runs.push(entry);
  if (dry) continue;
  const log = openSync(join(paths.output, `${name}.log`), 'wx');
  const start = performance.now();
  let timer;
  try {
    const child = spawn(argv[0], argv.slice(1), { cwd: workspace, detached: true, stdio: ['ignore', log, log], env: { ...process.env, UE_ENGINE_DIR: paths.engine, UE_ZEN_DDC_URL: c.zenUrl, 'UE-LocalDataCachePath': cache } });
    const stop = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const interrupt = () => { stop(); process.exitCode = 1; };
    process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
    timer = setTimeout(() => { entry.timedOut = true; stop(); }, c.timeoutSeconds * 1000);
    const outcome = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', (code, signal) => done({ code, signal })); });
    stop(); // Clean up any descendants left behind by a successful foreground command.
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    entry.exitCode = outcome.code; entry.signal = outcome.signal;
  } catch (error) { entry.error = String(error); } finally { clearTimeout(timer); closeSync(log); entry.durationMs = Math.round(performance.now() - start); }
  const du = spawnSync('du', ['-sb', cache, paths.sharedCache], { encoding: 'utf8' });
  if (du.status === 0) entry.diskBytes = du.stdout.trim().split('\n').map(line => Number(line.split(/\s/)[0]));
  writeFileSync(join(paths.output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  if (entry.exitCode !== 0) { process.exitCode = 1; break; }
}
if (dry) console.log(JSON.stringify(result, null, 2));
