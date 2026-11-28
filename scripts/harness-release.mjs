#!/usr/bin/env node
// Release the cezar harness from a commit (spec .ai/specs/2026-11-25-self-improving-factory.md, D9;
// roadmap M0.3). A thin layer over self-update: each release is a dedicated build worktree on its own
// `release/<sha7>` branch, registered with `linkCheckout` (so every release has its own version id)
// and switched with `activate` — `cezar use`. New here: wait for idle, the health check with
// automatic rollback, build pruning, and the release log.
//
//   node scripts/harness-release.mjs [<commit>]   build, link, wait for idle, switch, health-check
//   node scripts/harness-release.mjs --rollback   switch back to the previous release and open a draft revert PR
//   flags: --force (skip the idle wait)  --wait-minutes N (default 15)  --no-restart
//          --health-url URL (default http://127.0.0.1:4321/api/v1/health)  --keep N (default 5)
//          --health-seconds N (1-60, default 60; how long a restart has to answer with a new runtime id)
//          --unit NAME (default cezar)  --skip-checks (build only; no typecheck/tests)
//          --benchmark (stage and compare the harness smoke suite before switching)
//          --require-real-replays (for the protected workflow, validate affected real runner paths)
//          --hold-new-tasks (lease admission while waiting and switching; needs a compatible live cockpit)
//          --stage-only (build and check an isolated cockpit; leave the live version active)
//          --simulate-unhealthy (rollback drill; with --benchmark the post-switch smoke task fails after
//            the candidate answers health, without it the health check is skipped and fails)
// The health URL must be <origin>/api/v1/health and must answer it before anything switches.
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = process.env.CEZ_HOME || join(homedir(), '.cezar');
const FACTORY = join(HOME, 'factory');
const BUILDS = join(FACTORY, 'builds');
const LOG = join(FACTORY, 'release-log.ndjson');
const FACTORY_REF = 'refs/remotes/origin/factory';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const positional = args.filter((a, i) => !a.startsWith('--') && !['--wait-minutes', '--health-url', '--health-seconds', '--keep', '--unit'].includes(args[i - 1]));
const HEALTH_INPUT = value('health-url', 'http://127.0.0.1:4321/api/v1/health');
let HEALTH;
let API;
const UNIT = value('unit', 'cezar');
const KEEP = Number(value('keep', '5'));
const WAIT_MS = Number(value('wait-minutes', '15')) * 60_000;
const HEALTH_SECONDS = value('health-seconds', '60');
const HEALTH_MS = Number(HEALTH_SECONDS) * 1_000;
const RESTART_MS = 20_000;
const PROBE_MS = 10_000;
// The post-switch smoke: staging startup and task (30 s each), its history read and shutdown.
const SMOKE_MS = 90_000;
/** What a hold must still cover once traffic drains: two restarts, two probes and two health
 * windows (switch and rollback), plus the post-switch smoke when it runs. */
const RESERVE_MS = 2 * (RESTART_MS + PROBE_MS + HEALTH_MS) + (args.includes('--benchmark') ? SMOKE_MS : 0) + 15_000;
const HOLD_SECONDS = Math.min(15 * 60, Math.ceil(WAIT_MS / 1000));
/** Every valid runtime id seen before a restart; none of them can verify the next one. */
const seenRuntimes = new Set();

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
  const response = await fetch(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ seconds: HOLD_SECONDS }), signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('Could not hold traffic for a release (HTTP ' + response.status + ').');
  const lease = await response.json();
  const path = endpoint + '/' + encodeURIComponent(lease.id);
  const deadline = Date.parse(lease.expiresAt) - RESERVE_MS;
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

/** A wrong route made both the candidate and the rollback checks fail with 404 even though the
 * restored build was healthy, so the endpoint is checked before anything switches. */
function useHealthEndpoint(raw) {
  let url;
  try { url = new URL(raw); } catch { url = undefined; }
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
    url.search || url.hash || url.pathname !== '/api/v1/health') {
    throw new Error('--health-url must be <origin>/api/v1/health, without a query or credentials.');
  }
  HEALTH = url.origin + '/api/v1/health';
  API = url.origin + '/api/v1';
}

/** Refuse a probe the cockpit answered as a redirect or a missing route. A down cockpit (no
 * answer) or an unhealthy one (5xx) stays releasable, so a recovery or rollback can still run. */
async function preflightHealth() {
  let res;
  try {
    res = await fetch(HEALTH, { redirect: 'manual', signal: AbortSignal.timeout(5_000) });
  } catch (error) {
    say('cockpit not reachable for the health preflight (' + error.message + '); continuing as a recovery');
    return;
  }
  if (res.status >= 300 && res.status < 500) {
    throw new Error('The health URL ' + HEALTH + ' answered HTTP ' + res.status + '; refusing to switch.');
  }
  if (res.status >= 500) return say('the health URL answered HTTP ' + res.status + '; continuing as a recovery');
  remember(runtimeIdOf(await res.json().catch(() => undefined)));
}

/** Refuse what could not be checked or rolled back, before anything is built or switched. */
function checkOptions() {
  if (!/^\d+$/.test(HEALTH_SECONDS) || HEALTH_MS < 1_000 || HEALTH_MS > 60_000) {
    throw new Error('--health-seconds must be a whole number from 1 to 60 (D9: health within 60 s).');
  }
  if (flag('hold-new-tasks') && !flag('force') && HOLD_SECONDS * 1_000 <= RESERVE_MS) {
    throw new Error('The release hold (' + HOLD_SECONDS + ' s) cannot cover the switch, its checks and a rollback (' +
      Math.ceil(RESERVE_MS / 1000) + ' s); raise --wait-minutes.');
  }
  if (!flag('simulate-unhealthy')) return;
  for (const other of ['rollback', 'stage-only', 'no-restart']) {
    if (flag(other)) throw new Error('--simulate-unhealthy cannot be combined with --' + other + '.');
  }
}

// The health contract's runtimeId is z.string().uuid() (RFC 9562 versions 1-8).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const runtimeIdOf = (body) => {
  const id = body && typeof body === 'object' ? body.runtimeId : undefined;
  return typeof id === 'string' && UUID.test(id) ? id.toLowerCase() : undefined;
};
const remember = (id) => { if (id) seenRuntimes.add(id); };

/** A restart is verified only by a health answer carrying a runtime id never seen before it. */
async function healthy() {
  const deadline = Date.now() + HEALTH_MS;
  let last = 'no answer';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(HEALTH, { redirect: 'error', signal: AbortSignal.timeout(Math.min(5_000, Math.max(1, deadline - Date.now()))) });
      if (!res.ok) {
        last = 'HTTP ' + res.status;
      } else {
        const runtimeId = runtimeIdOf(await res.json().catch(() => undefined));
        if (runtimeId && !seenRuntimes.has(runtimeId)) {
          remember(runtimeId);
          return { ok: true, runtimeId };
        }
        last = runtimeId ? 'the new process has not answered' : 'the health answer has no valid runtime id';
      }
    } catch (error) {
      last = error.message;
    }
    await sleep(Math.min(2_000, Math.max(0, deadline - Date.now())));
  }
  return { ok: false, reason: last };
}

function restart() {
  if (flag('no-restart')) return say('--no-restart: not restarting the service');
  execFileSync('systemctl', ['--user', 'restart', UNIT], {
    cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], timeout: RESTART_MS,
  });
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

async function verifyRealReplays(packageRoot, sha, previous) {
  if (!flag('require-real-replays')) return true;
  const base = previous && lastSwitch(previous)?.sha;
  const paths = base ? run('git', ['diff', '--name-only', base, sha]).split('\n') : [];
  const changed = (pattern) => !base || paths.some(path => pattern.test(path));
  const needed = {
    agent: changed(/packages\/cezar\/src\/(core\/|workflows\/|managers\/(engine|prompts)|skills)|\.ai\/(skills|cezar\/workflows)|AGENTS\.md$/),
    judge: changed(/packages\/cezar\/src\/(scoring\/|core\/.*runner|core\/opencode)|\.ai\/cezar\/scorers/),
  };
  if (!needed.agent && !needed.judge) return true;
  const dist = join(packageRoot, 'dist');
  const { runHarnessRealReplaySuite } = await import(pathToFileURL(join(dist, 'benchmarks', 'harness-smoke.js')).href);
  const samples = await runHarnessRealReplaySuite(join(dist, 'index.js'), needed);
  const passed = samples.length > 0 && samples.every(sample => sample.passed);
  log({ action: 'real-benchmark', sha, result: passed ? 'ok' : 'failed', samples });
  if (!passed) say('required real replay checks failed; keeping the active harness');
  return passed;
}

/** Every runtime seen so far (preflight, earlier probes, the failed candidate) stays in
 * `seenRuntimes`, so a lost fresh probe cannot let an old process pass as the restarted one. */
async function activateAndVerify(su, id, simulateFailure = false, verifyWorkload) {
  let health;
  try {
    if (!flag('no-restart')) {
      remember(runtimeIdOf(await fetch(HEALTH, { redirect: 'error', signal: AbortSignal.timeout(PROBE_MS) })
        .then((res) => res.ok ? res.json() : undefined).catch(() => undefined)));
    }
    su.activate(id);
    su.writeLaunchers();
    restart();
    if (flag('no-restart')) return { ok: true };
    if (simulateFailure) return { ok: false, reason: 'simulated (--simulate-unhealthy)' };
    health = await healthy();
    if (health.ok && verifyWorkload) await verifyWorkload(su.versionEntry(id), health);
    return health;
  } catch (error) {
    return { ok: false, reason: error.message, ...(health?.runtimeId ? { runtimeId: health.runtimeId } : {}) };
  }
}

async function switchTo(su, id, previous, entry, verifyWorkload) {
  // With --benchmark the drill fails inside the post-switch smoke instead (see release()).
  const skipHealth = flag('simulate-unhealthy') && !flag('benchmark') && entry.action === 'switch';
  const health = await activateAndVerify(su, id, skipHealth, verifyWorkload);
  const runtime = health.runtimeId ? { runtimeId: health.runtimeId } : {};
  if (health.ok) {
    log({ ...entry, id, previous, result: 'ok', ...runtime });
    say(`now running ${id}`);
    return true;
  }
  log({ ...entry, id, previous, result: 'failed', reason: health.reason, ...runtime });
  say(`switch failed (${health.reason})`);
  if (previous) {
    const back = await activateAndVerify(su, previous);
    log({
      action: 'rollback', id: previous, from: id, result: back.ok ? 'ok' : 'failed', reason: back.reason, automatic: true,
      ...(back.runtimeId ? { runtimeId: back.runtimeId } : {}),
    });
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

async function candidateSmoke(packageRoot, entry, opts) {
  const stagingModule = join(packageRoot, 'dist', 'self-update', 'staging.js');
  const { smokeStagedHarness } = await import(pathToFileURL(stagingModule).href);
  return smokeStagedHarness(entry, opts);
}

let reportCandidate;
const reportStarted = Date.now();

/** Only the protected benchmarked path posts to the manager. The cockpit reads
 * the local report file; it never accepts caller-supplied manager text. */
async function reportRelease() {
  if (!reportCandidate || !flag('benchmark') || flag('stage-only')) return;
  const { sha, previous } = reportCandidate;
  const entries = releaseEntries().filter(entry => Date.parse(entry.at) >= reportStarted);
  const switched = entries.find(entry => entry.action === 'switch' && entry.sha === sha);
  const benchmark = entries.find(entry => entry.action === 'benchmark' && entry.sha === sha && typeof entry.passRate === 'number');
  const rolledBack = switched && entries.some(entry => entry.action === 'rollback' && entry.automatic &&
    entry.from === switched.id && entry.result === 'ok');
  const result = switched?.result === 'ok' ? 'switched' : rolledBack ? 'rolled-back' :
    switched?.result === 'failed' ? 'failed' : process.exitCode === 0 ? 'already-active' : 'blocked';
  const base = previous && lastSwitch(previous)?.sha;
  let changes = [];
  if (base && /^[a-f0-9]{40,64}$/.test(base)) {
    changes = run('git', ['log', '--first-parent', '--max-count=20', '--format=%s', base + '..' + sha])
      .split('\n').filter(subject => /\(#\d+\)$/.test(subject)).map(subject => subject.slice(0, 260));
  }
  const report = {
    id: randomUUID(), commit: sha, result, changes,
    ...(switched?.id || benchmark?.id ? { version: switched?.id ?? benchmark?.id } : {}),
    ...(previous ? { previous } : {}),
    ...(benchmark ? { benchmark: { passRate: benchmark.passRate, baseline: benchmark.baseline, tolerance: benchmark.tolerance } } : {}),
  };
  const path = join(FACTORY, 'last-release-report.json');
  const temp = path + '.' + report.id;
  writeFileSync(temp, JSON.stringify(report) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(temp, path);
  const response = await fetch(API + '/workspace/factory/release-report', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5_000),
  });
  const delivery = response.ok && await response.json();
  say(delivery?.delivered ? 'release report delivered to the harness manager' : 'release report saved locally');
}

async function release() {
  const stageOnly = flag('stage-only');
  if (!stageOnly) await preflightHealth();
  const spec = positional[0] ?? FACTORY_REF;
  if (!stageOnly || !positional[0]) {
    const fetched = spawnSync('git', ['fetch', '--quiet', '--no-tags', 'origin', '+refs/heads/factory:' + FACTORY_REF], {
      cwd: REPO, timeout: 30_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    if (fetched.status !== 0) throw new Error('Could not verify the current origin/factory branch.');
  }
  const sha = run('git', ['rev-parse', '--verify', '--end-of-options', `${spec}^{commit}`]);
  if (!stageOnly) {
    const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', sha, FACTORY_REF], { cwd: REPO });
    if (ancestor.status === 1) throw new Error('The candidate is not merged into origin/factory.');
    if (ancestor.status !== 0) throw new Error('Could not verify the candidate against origin/factory.');
  }
  reportCandidate = { sha };
  const sha7 = sha.slice(0, 7);
  const dir = join(BUILDS, sha7);
  const branch = `release/${sha7}`;
  const packageRoot = join(dir, 'packages', 'cezar');
  say(`releasing ${sha7} (${spec})`);
  log({ action: 'build', sha, result: 'started' });

  const built = existsSync(join(packageRoot, 'dist', 'index.js')) && existsSync(join(packageRoot, 'web', 'dist'));
  const validateRelease = !stageOnly && flag('benchmark') && !flag('skip-checks');
  try {
    if (!built) {
      mkdirSync(BUILDS, { recursive: true });
      if (!existsSync(dir)) run('git', ['worktree', 'add', '--force', '-B', branch, dir, sha]);
      runLoud('npm', ['ci', '--no-audit', '--no-fund'], dir);
    }
    // An existing build may have come from staging or from an interrupted validation.
    if (!built || validateRelease) {
      if (!flag('skip-checks')) runLoud('npm', ['run', 'typecheck'], dir);
      if (validateRelease) {
        runLoud('npm', ['test'], dir);
        runLoud('npm', ['run', 'test:unit'], dir);
      }
      runLoud('npm', ['run', 'build'], dir);
      if (validateRelease) runLoud('npm', ['run', 'test:package'], dir);
      // The global `cezar`/`cez` (and the launchers) exec this entry: keep it executable.
      spawnSync('chmod', ['+x', join(packageRoot, 'dist', 'index.js')]);
    } else {
      say(`build ${sha7} already exists`);
    }
  } catch (error) {
    say(`build failed: ${error.message}`);
    log({ action: 'build', sha, result: 'failed', reason: error.message });
    return 1;
  }
  log({ action: 'build', sha, result: 'ok' });

  if (stageOnly) {
    await candidateSmoke(packageRoot, join(packageRoot, 'dist', 'index.js'));
    log({ action: 'stage', sha, result: 'ok' });
    say('candidate completed its isolated smoke task');
    return 0;
  }

  const su = await selfUpdate(packageRoot);
  const previous = su.activeId();
  reportCandidate.previous = previous;
  if (flag('simulate-unhealthy') && !su.listInstalled().some((entry) => entry.id === previous)) {
    const reason = 'the rollback drill needs an installed active version to roll back to';
    log({ action: 'switch', sha, result: 'failed', reason });
    say(reason + '; nothing was switched');
    return 1;
  }
  if (flag('benchmark')) {
    const version = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version;
    if (!await benchmark(packageRoot, su, sha, su.linkId(version, branch), previous)) return 1;
    if (!await verifyRealReplays(packageRoot, sha, previous)) return 1;
  }
  const linked = su.linkCheckout(packageRoot, branch);
  say(`linked ${linked.id}${previous ? ` (current: ${previous})` : ''}`);
  if (linked.id === previous) {
    say('already the active release');
    if (flag('simulate-unhealthy')) {
      const reason = 'the rollback drill needs a candidate that differs from the active release';
      log({ action: 'switch', sha, result: 'failed', reason });
      say(reason);
      return 1;
    }
    return 0;
  }
  const drill = flag('simulate-unhealthy') && flag('benchmark');
  const verifyWorkload = flag('benchmark') ? async (entry, health) => {
    // The smoke runs only once the restarted candidate answered health; its runtime id says which.
    const runtime = { runtimeId: health.runtimeId };
    let outcome;
    try {
      outcome = await candidateSmoke(packageRoot, entry, drill ? { simulateFailure: true } : {});
    } catch (error) {
      log({ action: 'post-switch-smoke', sha, result: 'failed', reason: error.message, ...runtime });
      throw new Error('post-switch smoke failed: ' + error.message);
    }
    if (!drill) return log({ action: 'post-switch-smoke', sha, result: 'ok', ...runtime });
    // Only the check outcome the staging run verified counts as simulated; an older candidate
    // that ignores the option passes its smoke, and still must not switch.
    const check = outcome?.simulatedFailure;
    if (check) {
      log({ action: 'post-switch-smoke', sha, result: 'failed', simulated: true, check, reason: check.error, ...runtime });
      throw new Error('simulated post-switch smoke failure (--simulate-unhealthy): ' + check.error);
    }
    const reason = 'the candidate did not run the drill check';
    log({ action: 'post-switch-smoke', sha, result: 'failed', reason, ...runtime });
    throw new Error('post-switch smoke failed: ' + reason);
  } : undefined;
  const ok = await withReleaseHold(() => switchTo(su, linked.id, previous, { action: 'switch', sha }, verifyWorkload));
  pruneBuilds(su, [linked.id, previous].filter(Boolean));
  return ok ? 0 : 1;
}

async function openRollbackPr(entryRoot, sha) {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(sha)) throw new Error('The rolled-back build has no valid commit.');
  const { parseRemote } = await import(pathToFileURL(join(entryRoot, 'dist', 'git-remotes.js')).href);
  const remote = parseRemote(run('git', ['config', '--get', 'remote.origin.url']));
  if (!remote || remote.host !== 'github.com') throw new Error('The factory fork needs a GitHub origin for a revert PR.');
  const repo = [remote.host, remote.owner, remote.repo].join('/');
  const branch = 'revert/harness-' + sha.slice(0, 12);
  const existing = JSON.parse(run('gh', ['pr', 'list', '--repo', repo, '--base', 'factory', '--head', branch, '--json', 'url', '--limit', '1']));
  if (existing[0]?.url) return existing[0].url;

  run('git', ['fetch', '--quiet', 'origin', '+refs/heads/factory:refs/remotes/origin/factory']);
  const base = 'refs/remotes/origin/factory';
  run('git', ['merge-base', '--is-ancestor', sha, base]);
  const account = JSON.parse(run('gh', ['api', 'user', '--hostname', remote.host]));
  if (!Number.isSafeInteger(account.id) || typeof account.login !== 'string' || !/^[a-z0-9-]+$/i.test(account.login)) throw new Error('Could not identify the public GitHub account.');
  const email = account.id + '+' + account.login + '@users.noreply.github.com';
  const scratch = mkdtempSync(join(tmpdir(), 'cez-harness-revert-'));
  const tree = join(scratch, 'checkout');
  const body = join(scratch, 'pr.md');
  try {
    run('git', ['worktree', 'add', '--detach', tree, base]);
    run('git', ['-c', 'user.name=Cezar Factory', '-c', 'user.email=' + email, '-c', 'commit.gpgSign=false', 'revert', '--no-edit', sha], tree);
    run('git', ['push', 'origin', 'HEAD:refs/heads/' + branch], tree);
    writeFileSync(body, 'The harness was rolled back after release ' + sha.slice(0, 12) + '. This reverts the release commit.\n');
    return run('gh', [
      'pr', 'create', '--repo', repo, '--base', 'factory', '--head', branch, '--draft',
      '--title', 'Revert harness release ' + sha.slice(0, 12), '--body-file', body,
    ], tree);
  } finally {
    if (existsSync(tree)) spawnSync('git', ['worktree', 'remove', '--force', tree], { cwd: REPO });
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function rollback() {
  const entryRoot = realpathSync(join(HOME, 'versions', 'current', 'node_modules', '@open-mercato', 'cezar'));
  const su = await selfUpdate(entryRoot);
  const current = su.activeId();
  const release = lastSwitch(current);
  const target = release?.previous;
  if (!target || target === current) throw new Error('no previous release recorded to roll back to');
  await preflightHealth();
  say(`rolling back ${current} → ${target}`);
  const ok = await withReleaseHold(() => switchTo(su, target, current, { action: 'rollback', from: current }));
  if (!ok) return 1;
  if (release.sha) {
    try {
      const url = await openRollbackPr(entryRoot, release.sha);
      log({ action: 'revert-pr', sha: release.sha, id: target, result: 'ok', url });
      say('opened revert PR ' + url);
    } catch {
      log({ action: 'revert-pr', sha: release.sha, id: target, result: 'failed' });
      say('restored the previous version; could not open its revert PR');
      return 4;
    }
  }
  return 0;
}

try {
  useHealthEndpoint(HEALTH_INPUT);
  checkOptions();
  process.exitCode = flag('rollback') ? await rollback() : await release();
} catch (error) {
  say(`failed: ${error.message}`);
  log({ action: flag('rollback') ? 'rollback' : flag('stage-only') ? 'stage' : 'switch', result: error.code === 'busy' ? 'busy' : 'failed', reason: error.message });
  process.exitCode = error.code === 'busy' ? 3 : 1;
}

if (API) await reportRelease().catch(() => say('could not deliver the harness release report'));
