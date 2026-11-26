#!/usr/bin/env node
// Release the cezar harness from a commit (spec .ai/specs/2026-11-25-self-improving-factory.md, D9;
// roadmap M0.3). A thin layer over self-update: each release is a dedicated build worktree on its own
// `release/<sha7>` branch, registered with `linkCheckout` (so every release has its own version id)
// and switched with `activate` — `cezar use`. New here: wait for idle, the health check with
// automatic rollback, build pruning, and the release log.
//
//   node scripts/harness-release.mjs [<commit>]   build, link, wait for idle, switch, health-check
//   node scripts/harness-release.mjs --rollback   switch back to the previous release
//   flags: --force (skip the idle wait)  --wait-minutes N (default 15)  --no-restart
//          --health-url URL (default http://127.0.0.1:4321/api/v1/health)  --keep N (default 5)
//          --unit NAME (default cezar)  --skip-checks (build only; no typecheck/tests)
//          --benchmark (stage and compare the harness smoke suite before switching)
//          --hold-new-tasks (lease admission while waiting and switching; needs a compatible live cockpit)
//          --stage-only (build and check an isolated cockpit; leave the live version active)
//          --simulate-unhealthy (test the automatic rollback: the new version's health check fails)
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = process.env.CEZ_HOME || join(homedir(), '.cezar');
const FACTORY = join(HOME, 'factory');
const BUILDS = join(FACTORY, 'builds');
const LOG = join(FACTORY, 'release-log.ndjson');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const positional = args.filter((a, i) => !a.startsWith('--') && !['--wait-minutes', '--health-url', '--keep', '--unit'].includes(args[i - 1]));
const HEALTH = value('health-url', 'http://127.0.0.1:4321/api/v1/health');
const API = HEALTH.replace(/\/api\/v1\/health$/, '/api/v1');
const UNIT = value('unit', 'cezar');
const KEEP = Number(value('keep', '5'));
const WAIT_MS = Number(value('wait-minutes', '15')) * 60_000;

const say = (line) => console.log(`harness-release: ${line}`);
const run = (cmd, argv, cwd = REPO) => execFileSync(cmd, argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim();
const runLoud = (cmd, argv, cwd) => {
  const res = spawnSync(cmd, argv, { cwd, stdio: 'inherit' });
  if (res.status !== 0) throw new Error(`${cmd} ${argv.join(' ')} failed (exit ${res.status})`);
};
function log(entry) {
  mkdirSync(FACTORY, { recursive: true });
  appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

/** Busy = a task running or queued in any project, or a manager turn in progress. */
async function busyReasons() {
  const reasons = [];
  try {
    const { projects } = await getJson(`${API}/projects`);
    for (const p of projects ?? []) {
      const runs = await getJson(`${API}/p/${encodeURIComponent(p.id)}/runs`).catch(() => []);
      for (const r of Array.isArray(runs) ? runs : runs.runs ?? []) {
        if (['running', 'queued', 'starting'].includes(r.status)) reasons.push(`${p.id} task ${String(r.id).slice(0, 8)} ${r.status}`);
      }
    }
    const managers = await getJson(`${API}/workspace/managers`).catch(() => []);
    for (const m of Array.isArray(managers) ? managers : managers.managers ?? []) {
      if (m.status === 'working') reasons.push(`manager ${m.name} is working`);
    }
  } catch (error) {
    // The cockpit is down: nothing is running through it.
    say(`cockpit not reachable for the idle check (${error.message}); treating it as idle`);
  }
  return reasons;
}

async function waitForIdle() {
  if (flag('force')) return;
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const reasons = await busyReasons();
    if (!reasons.length) return;
    if (Date.now() > deadline) throw Object.assign(new Error(`still busy after the wait: ${reasons.join('; ')}`), { code: 'busy' });
    say(`waiting for idle: ${reasons.join('; ')}`);
    await sleep(15_000);
  }
}

async function withReleaseHold(action) {
  if (!flag('hold-new-tasks') || flag('force')) {
    await waitForIdle();
    return action();
  }
  const endpoint = API + '/workspace/factory/release-hold';
  const seconds = Math.min(15 * 60, Math.ceil(WAIT_MS / 1000));
  const response = await fetch(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ seconds }), signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('Could not hold traffic for a release (HTTP ' + response.status + ').');
  const lease = await response.json();
  const path = endpoint + '/' + encodeURIComponent(lease.id);
  // Leave a minute for restart and health verification within the lease.
  const deadline = Date.parse(lease.expiresAt) - 60_000;
  try {
    log({ action: 'hold', result: 'started', expiresAt: lease.expiresAt });
    let status = lease;
    while (Date.now() < deadline) {
      if (status.activeTasks === 0 && status.activeManagers === 0) {
        log({ action: 'hold', result: 'idle' });
        return await action();
      }
      say('waiting for ' + status.activeTasks + ' active tasks and ' + status.activeManagers + ' manager turns');
      await sleep(Math.min(5000, Math.max(0, deadline - Date.now())));
      status = await getJson(path);
    }
    throw Object.assign(new Error('The cockpit did not drain before the release hold deadline.'), { code: 'busy' });
  } finally {
    await fetch(path, { method: 'DELETE', signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
  }
}

async function healthy(priorRuntime) {
  const deadline = Date.now() + 60_000;
  let last = 'no answer';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(HEALTH, { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) {
        last = 'HTTP ' + res.status;
      } else {
        const runtime = priorRuntime ? (await res.json()).runtimeId : undefined;
        if (!priorRuntime || runtime && runtime !== priorRuntime) return { ok: true };
        last = 'the new process has not answered';
      }
    } catch (error) {
      last = error.message;
    }
    await sleep(2_000);
  }
  return { ok: false, reason: last };
}

function restart() {
  if (flag('no-restart')) return say('--no-restart: not restarting the service');
  run('systemctl', ['--user', 'restart', UNIT]);
}

/** Self-update's own code, from a built tree (the build being released, or the active one). */
async function selfUpdate(packageRoot) {
  const dist = join(packageRoot, 'dist', 'self-update');
  const layout = await import(pathToFileURL(join(dist, 'layout.js')).href);
  const launcher = await import(pathToFileURL(join(dist, 'launcher.js')).href);
  return { ...layout, ...launcher };
}

function releaseEntries() {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).reverse();
}

function lastSwitch(id) {
  // An automatic rollback's 'from' is the failed candidate, never a rollback target.
  return releaseEntries().find((e) => e.action === 'switch' && e.result === 'ok' && e.id === id);
}

async function benchmark(packageRoot, su, sha, id, previous) {
  const dist = join(packageRoot, 'dist');
  const { HARNESS_SMOKE_SUITE: suite, runHarnessSmokeSuite } =
    await import(pathToFileURL(join(dist, 'benchmarks', 'harness-smoke.js')).href);
  const { loadWorkspaceConfig } = await import(pathToFileURL(join(dist, 'workspace', 'config.js')).href);
  const tolerance = (await loadWorkspaceConfig()).factory?.release?.benchmarkTolerance ?? 10;
  log({ action: 'benchmark', suite, sha, id, result: 'started' });
  const cached = previous && releaseEntries().find((entry) =>
    entry.action === 'benchmark' && entry.suite === suite && entry.id === previous && entry.result === 'ok');
  const baseline = cached?.passRate ?? (previous ? (await runHarnessSmokeSuite(su.versionEntry(previous))).passRate : 100);
  const candidate = await runHarnessSmokeSuite(join(dist, 'index.js'));
  const passed = candidate.passRate >= baseline - tolerance;
  log({ action: 'benchmark', suite, sha, id, baseline, tolerance, ...candidate, result: passed ? 'ok' : 'failed' });
  say('benchmark pass rate ' + candidate.passRate + '%, previous ' + baseline + '%, tolerance ' + tolerance + ' points');
  return passed;
}

async function activateAndVerify(su, id, simulateFailure = false) {
  try {
    const priorRuntime = flag('no-restart') || simulateFailure ? undefined
      : (await getJson(HEALTH).catch(() => undefined))?.runtimeId;
    su.activate(id);
    su.writeLaunchers();
    restart();
    if (flag('no-restart')) return { ok: true };
    if (simulateFailure) return { ok: false, reason: 'simulated (--simulate-unhealthy)' };
    return await healthy(priorRuntime);
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

async function switchTo(su, id, previous, entry) {
  const health = await activateAndVerify(su, id, flag('simulate-unhealthy') && entry.action === 'switch');
  if (health.ok) {
    log({ ...entry, id, previous, result: 'ok' });
    say(`now running ${id}`);
    return true;
  }
  log({ ...entry, id, previous, result: 'failed', reason: health.reason });
  say(`switch failed (${health.reason})`);
  if (previous) {
    const back = await activateAndVerify(su, previous);
    log({ action: 'rollback', id: previous, from: id, result: back.ok ? 'ok' : 'failed', reason: back.reason, automatic: true });
    say(back.ok ? `rolled back to ${previous}` : `rollback to ${previous} failed: ${back.reason}`);
  }
  return false;
}

function pruneBuilds(su, keepIds) {
  if (!existsSync(BUILDS)) return;
  const dirs = readdirSync(BUILDS)
    .map((name) => ({ name, path: join(BUILDS, name), mtime: statSync(join(BUILDS, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  const linked = su.listLinks();
  for (const [i, d] of dirs.entries()) {
    const entry = linked.find((l) => l.checkout?.startsWith(d.path));
    if (i < KEEP || (entry && keepIds.includes(entry.id))) continue;
    say(`pruning build ${d.name}`);
    if (entry && !keepIds.includes(entry.id)) su.removeInstalled(entry.id);
    spawnSync('git', ['worktree', 'remove', '--force', d.path], { cwd: REPO });
    spawnSync('git', ['branch', '-D', `release/${d.name}`], { cwd: REPO });
    if (existsSync(d.path)) rmSync(d.path, { recursive: true, force: true });
  }
}

async function release() {
  const spec = positional[0] ?? 'origin/factory';
  spawnSync('git', ['fetch', '--quiet', 'origin', 'factory'], { cwd: REPO });
  const sha = run('git', ['rev-parse', `${spec}^{commit}`]);
  const sha7 = sha.slice(0, 7);
  const dir = join(BUILDS, sha7);
  const branch = `release/${sha7}`;
  const packageRoot = join(dir, 'packages', 'cezar');
  say(`releasing ${sha7} (${spec})`);
  log({ action: 'build', sha, result: 'started' });

  if (!existsSync(join(packageRoot, 'dist', 'index.js')) || !existsSync(join(packageRoot, 'web', 'dist'))) {
    mkdirSync(BUILDS, { recursive: true });
    if (!existsSync(dir)) run('git', ['worktree', 'add', '--force', '-B', branch, dir, sha]);
    runLoud('npm', ['ci', '--no-audit', '--no-fund'], dir);
    if (!flag('skip-checks')) runLoud('npm', ['run', 'typecheck'], dir);
    runLoud('npm', ['run', 'build'], dir);
    // The global `cezar`/`cez` (and the launchers) exec this entry: keep it executable.
    spawnSync('chmod', ['+x', join(packageRoot, 'dist', 'index.js')]);
  } else {
    say(`build ${sha7} already exists`);
  }
  log({ action: 'build', sha, result: 'ok' });

  if (flag('stage-only')) {
    const stagingModule = join(packageRoot, 'dist', 'self-update', 'staging.js');
    const { smokeStagedHarness } = await import(pathToFileURL(stagingModule).href);
    await smokeStagedHarness(join(packageRoot, 'dist', 'index.js'));
    log({ action: 'stage', sha, result: 'ok' });
    say('candidate completed its isolated smoke task');
    return 0;
  }

  const su = await selfUpdate(packageRoot);
  const previous = su.activeId();
  if (flag('benchmark')) {
    const version = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version;
    if (!await benchmark(packageRoot, su, sha, su.linkId(version, branch), previous)) return 1;
  }
  const linked = su.linkCheckout(packageRoot, branch);
  say(`linked ${linked.id}${previous ? ` (current: ${previous})` : ''}`);
  if (linked.id === previous) {
    say('already the active release');
    return 0;
  }
  const ok = await withReleaseHold(() => switchTo(su, linked.id, previous, { action: 'switch', sha }));
  pruneBuilds(su, [linked.id, previous].filter(Boolean));
  return ok ? 0 : 1;
}

async function rollback() {
  const entryRoot = resolve(join(HOME, 'versions', 'current', 'node_modules', '@open-mercato', 'cezar'));
  const su = await selfUpdate(entryRoot);
  const current = su.activeId();
  const target = lastSwitch(current)?.previous;
  if (!target || target === current) throw new Error('no previous release recorded to roll back to');
  say(`rolling back ${current} → ${target}`);
  const ok = await withReleaseHold(() => switchTo(su, target, current, { action: 'rollback', from: current }));
  return ok ? 0 : 1;
}

try {
  process.exitCode = flag('rollback') ? await rollback() : await release();
} catch (error) {
  say(`failed: ${error.message}`);
  log({ action: flag('rollback') ? 'rollback' : flag('stage-only') ? 'stage' : 'switch', result: error.code === 'busy' ? 'busy' : 'failed', reason: error.message });
  process.exitCode = error.code === 'busy' ? 3 : 1;
}
