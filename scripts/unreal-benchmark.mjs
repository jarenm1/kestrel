#!/usr/bin/env node
// Runs only in operator-prepared disposable workspaces and caches. No shell is involved.
import { spawn, spawnSync } from 'node:child_process';
import { realpathSync, readdirSync, writeFileSync, writeSync, openSync, closeSync } from 'node:fs';
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

const coldCacheNote = 'The runner cannot inspect, reset or prove the state of the remote Zen service. a-cold is only a label: the operator must independently attest that the shared cache was cold before that phase and record the evidence separately. Disk sizes are local measurements and are not cold-cache evidence.';
const diskNote = 'diskBytes is [localCache, sharedCache] in bytes from du after the phase. It measures storage on this host only; it is not evidence of remote Zen state or of cache hits.';
const cacheAssumption = (name, index) => name === 'a-cold'
  ? 'remote shared cache must be operator-attested as cold before this phase'
  : index === 1
    ? 'remote shared cache assumed populated by the preceding phase'
    : 'remote shared cache assumed populated by earlier phases and the other workspace';

const result = {
  version: 1,
  synthetic: c.synthetic === true,
  dryRun: dry,
  engineIdentity: c.engineIdentity,
  projectRevision: revisions[0],
  config: c,
  paths,
  cacheEvidence: 'unknown',
  coldCache: { status: dry ? 'not-run' : 'not-attested', note: coldCacheNote },
  diskMeasurement: { measured: false, note: diskNote },
  interrupted: false,
  runs: []
};

let interrupted = false;
let interruptSignal = null;
let stopCurrent = null;
const onSignal = signal => {
  if (interrupted) return;
  interrupted = true;
  interruptSignal = signal;
  result.interrupted = true;
  result.interruptSignal = signal;
  process.exitCode = 1;
  stopCurrent?.();
};
const onSigint = () => onSignal('SIGINT');
const onSigterm = () => onSignal('SIGTERM');
process.on('SIGINT', onSigint);
process.on('SIGTERM', onSigterm);
try {
  for (const [index, [name, workspace, cache]] of runs.entries()) {
    if (interrupted) break;
    const argv = c.argv.map(x => expand(x, workspace, cache));
    const entry = {
      name,
      argv,
      cwd: workspace,
      cacheAssumption: cacheAssumption(name, index),
      remoteCacheState: 'unverified',
      durationMs: null,
      exitCode: null,
      signal: null,
      timedOut: false,
      interrupted: false,
      diskBytes: null,
      diskNote,
      resourceMetrics: 'unavailable'
    };
    result.runs.push(entry);
    if (dry) continue;
    const log = openSync(join(paths.output, `${name}.log`), 'wx');
    writeSync(log, `# ${name}: ${entry.cacheAssumption}. ${diskNote}\n`);
    const start = performance.now();
    let timer;
    try {
      // Launch and setting stopCurrent are synchronous, so a signal handler cannot run
      // before stopCurrent exists; it runs once this function awaits the child.
      const child = spawn(argv[0], argv.slice(1), { cwd: workspace, detached: true, stdio: ['ignore', log, log], env: { ...process.env, UE_ENGINE_DIR: paths.engine, UE_ZEN_DDC_URL: c.zenUrl, 'UE-LocalDataCachePath': cache } });
      const stop = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
      stopCurrent = stop;
      timer = setTimeout(() => { entry.timedOut = true; stop(); }, c.timeoutSeconds * 1000);
      const outcome = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', (code, signal) => done({ code, signal })); });
      stop(); // Clean up any descendants left behind by a successful foreground command.
      entry.exitCode = outcome.code; entry.signal = outcome.signal;
    } catch (error) {
      entry.error = String(error);
      interrupted = true; // A child launch failure also stops the sequence.
    } finally {
      clearTimeout(timer);
      stopCurrent = null;
      entry.interrupted = interrupted;
      entry.durationMs = Math.round(performance.now() - start);
      closeSync(log);
    }
    const du = spawnSync('du', ['-sb', cache, paths.sharedCache], { encoding: 'utf8' });
    if (du.status === 0) {
      entry.diskBytes = du.stdout.trim().split('\n').map(line => Number(line.split(/\s/)[0]));
      result.diskMeasurement.measured = true;
    }
    writeFileSync(join(paths.output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    if (entry.error || entry.timedOut || entry.exitCode !== 0 || interrupted) { process.exitCode = 1; break; }
  }
} finally {
  process.removeListener('SIGINT', onSigint);
  process.removeListener('SIGTERM', onSigterm);
  result.interrupted = interrupted;
  if (interruptSignal) result.interruptSignal = interruptSignal;
  if (dry) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (result.runs.length) writeFileSync(join(paths.output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ output: paths.output, phases: result.runs.map(x => x.name), interrupted, cacheEvidence: result.cacheEvidence, coldCache: result.coldCache.status, diskMeasured: result.diskMeasurement.measured }));
  }
}
