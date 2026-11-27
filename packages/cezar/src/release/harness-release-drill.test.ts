import { execFile, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';

// D9: the health URL is checked before any switch, and the rollback drill fails inside the post-switch smoke.
const exec = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture(health: 'ok' | 'not-found' | 'redirect' | 'error' | 'down' = 'ok') {
  const root = await mkdtemp(join(tmpdir(), 'cez-release-drill-'));
  const workspace = join(root, 'workspace');
  const commands = join(root, 'commands');
  const state = join(workspace, 'active.txt');
  const restarts = join(workspace, 'restarts.log');
  const smokes = join(workspace, 'smokes.log');
  // Health answers with the active version as its runtime id, so a restart shows up as a new runtime.
  const server: Server = createServer((request, response) => {
    if (health === 'ok' && request.url === '/api/v1/health') {
      response.setHeader('content-type', 'application/json');
      return response.end(JSON.stringify({ runtimeId: readFileSync(state, 'utf8') }));
    }
    if (health === 'redirect') response.setHeader('location', '/elsewhere');
    response.statusCode = health === 'redirect' ? 302 : health === 'error' ? 503 : 404;
    response.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing loopback listener');
  const port = address.port;
  if (health === 'down') server.close();
  cleanups.push(async () => {
    if (health !== 'down') server.close();
    await rm(root, { recursive: true, force: true });
  });

  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'factory');
  git('-c', 'user.name=Release Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgSign=false',
    'commit', '-qm', 'fixture', '--allow-empty');
  git('init', '-q', '--bare', join(root, 'remote.git'));
  git('remote', 'add', 'origin', join(root, 'remote.git'));
  git('push', '-q', 'origin', 'HEAD:refs/heads/factory');
  const sha = git('rev-parse', 'HEAD');
  const candidate = join(workspace, 'factory', 'builds', sha.slice(0, 7), 'packages', 'cezar');
  const dist = join(candidate, 'dist');
  await Promise.all(['self-update', 'benchmarks', 'workspace'].map((dir) => mkdir(join(dist, dir), { recursive: true })));
  await Promise.all([mkdir(join(candidate, 'web', 'dist'), { recursive: true }), mkdir(commands), mkdir(join(root, 'scripts'))]);
  const release = join(root, 'scripts', 'harness-release.mjs');
  await Promise.all([
    copyFile(new URL('../../../../scripts/harness-release.mjs', import.meta.url), release),
    writeFile(join(root, 'package.json'), '{"type":"module"}'),
    writeFile(state, 'previous'),
    writeFile(join(candidate, 'package.json'), '{"version":"0.1.0","type":"module"}'),
    writeFile(join(dist, 'index.js'), ''),
    writeFile(join(dist, 'self-update', 'launcher.js'), 'export function writeLaunchers() {}'),
    writeFile(join(dist, 'self-update', 'layout.js'), `
      import { readFileSync, writeFileSync } from 'node:fs';
      export const activeId = () => readFileSync(process.env.RELEASE_TEST_STATE, 'utf8');
      export const activate = id => writeFileSync(process.env.RELEASE_TEST_STATE, id);
      export const linkCheckout = () => ({ id: 'candidate' });
      export const listLinks = () => [];
      export const versionEntry = id => '/' + id + '-entry';
      export const linkId = () => 'candidate';
    `),
    // The real smoke runs a failing check step when asked; this stand-in fails the same way.
    writeFile(join(dist, 'self-update', 'staging.js'), `
      import { appendFileSync } from 'node:fs';
      export const smokeStagedHarness = async (entry, opts = {}) => {
        appendFileSync(process.env.RELEASE_TEST_SMOKES, entry + ' ' + JSON.stringify(opts) + '\\n');
        if (opts.simulateFailure) throw new Error('The staged smoke task did not complete successfully.');
      };
    `),
    writeFile(join(dist, 'benchmarks', 'harness-smoke.js'), [
      'export const HARNESS_SMOKE_SUITE = "fixture";',
      'export const runHarnessSmokeSuite = async () => ({ passRate: 100, samples: [] });',
    ].join('\n')),
    writeFile(join(dist, 'workspace', 'config.js'), 'export const loadWorkspaceConfig = async () => ({});'),
    writeFile(join(commands, 'systemctl'), '#!/bin/sh\necho "$*" >> "$RELEASE_TEST_RESTARTS"\n'),
    writeFile(join(commands, 'npm'), '#!/bin/sh\nexit 0\n'),
  ]);
  await Promise.all([chmod(join(commands, 'systemctl'), 0o755), chmod(join(commands, 'npm'), 0o755)]);

  const releaseLog = join(workspace, 'factory', 'release-log.ndjson');
  const lines = async (file: string) => (await readFile(file, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
  return {
    sha,
    workspace,
    dist,
    state,
    releaseLog,
    healthUrl: (path = '/api/v1/health') => 'http://127.0.0.1:' + port + path,
    execute: (...flags: string[]) => exec(process.execPath, [release, sha, '--force', ...flags], {
      timeout: 15_000,
      env: {
        ...process.env, CEZ_HOME: workspace, PATH: commands + ':' + process.env.PATH,
        RELEASE_TEST_STATE: state, RELEASE_TEST_RESTARTS: restarts, RELEASE_TEST_SMOKES: smokes,
      },
    }),
    active: () => readFile(state, 'utf8'),
    restarts: () => lines(restarts),
    smokes: () => lines(smokes),
    log: async () => (await lines(releaseLog)).map((line) => JSON.parse(line) as Record<string, unknown>),
    report: async () => JSON.parse(await readFile(join(workspace, 'factory', 'last-release-report.json'), 'utf8')),
  };
}

it.skipIf(process.platform === 'win32').each([
  ['a nonexistent route', 'ok', '/api/v1/nonexistent', '--health-url must be <origin>/api/v1/health'],
  ['a route that answers 404', 'not-found', '/api/v1/health', 'answered HTTP 404; refusing to switch'],
  ['a route that redirects', 'redirect', '/api/v1/health', 'answered HTTP 302; refusing to switch'],
] as const)('never switches or restarts with %s as the health URL', async (_name, health, path, reason) => {
  const release = await fixture(health);
  await expect(release.execute('--benchmark', '--health-url', release.healthUrl(path))).rejects.toMatchObject({ code: 1 });
  expect(await release.active()).toBe('previous');
  expect(await release.restarts()).toEqual([]);
  const log = await release.log();
  expect(log).toEqual([expect.objectContaining({ action: 'switch', result: 'failed' })]);
  expect(String(log[0]!.reason)).toContain(reason);
}, 20_000);

it.skipIf(process.platform === 'win32')('keeps a release possible while the cockpit is down', async () => {
  const release = await fixture('down');
  await release.execute('--no-restart', '--health-url', release.healthUrl());
  expect(await release.active()).toBe('candidate');
}, 20_000);

it.skipIf(process.platform === 'win32')('still rolls back by hand while the active version answers 5xx', async () => {
  const release = await fixture('error');
  const active = join(release.workspace, 'versions', 'current', 'node_modules', '@open-mercato', 'cezar', 'dist', 'self-update');
  await mkdir(active, { recursive: true });
  for (const file of ['layout.js', 'launcher.js']) await copyFile(join(release.dist, 'self-update', file), join(active, file));
  await writeFile(release.state, 'candidate');
  await mkdir(join(release.workspace, 'factory'), { recursive: true });
  await writeFile(release.releaseLog, JSON.stringify({ action: 'switch', id: 'candidate', previous: 'previous', result: 'ok' }) + '\n');
  await release.execute('--rollback', '--no-restart', '--health-url', release.healthUrl());
  expect(await release.active()).toBe('previous');
}, 20_000);

it.skipIf(process.platform === 'win32')('refuses a drill that could not fail its post-switch check', async () => {
  const release = await fixture();
  await expect(release.execute('--benchmark', '--simulate-unhealthy', '--no-restart', '--health-url', release.healthUrl()))
    .rejects.toMatchObject({ code: 1 });
  expect(await release.active()).toBe('previous');
  expect((await release.log()).at(-1)?.reason).toBe('--simulate-unhealthy cannot be combined with --no-restart.');
}, 20_000);

it.skipIf(process.platform === 'win32')(
  'drills benchmark, healthy candidate, failing post-switch smoke and verified rollback, then releases normally',
  async () => {
    const release = await fixture();
    const flags = ['--benchmark', '--health-url', release.healthUrl()];
    await expect(release.execute(...flags, '--simulate-unhealthy')).rejects.toMatchObject({ code: 1 });
    expect(await release.active()).toBe('previous');
    expect(await release.restarts()).toHaveLength(2);
    expect(await release.smokes()).toEqual(['/candidate-entry {"simulateFailure":true}']);
    const drill = (await release.log()).filter((entry) => entry.action !== 'build');
    expect(drill).toEqual([
      expect.objectContaining({ action: 'benchmark', result: 'started' }),
      expect.objectContaining({ action: 'benchmark', sha: release.sha, passRate: 100, baseline: 100, result: 'ok' }),
      expect.objectContaining({
        action: 'post-switch-smoke', sha: release.sha, result: 'failed', simulated: true, runtimeId: 'candidate',
        reason: 'The staged smoke task did not complete successfully.',
      }),
      expect.objectContaining({
        action: 'switch', sha: release.sha, id: 'candidate', previous: 'previous', result: 'failed',
        reason: expect.stringContaining('simulated post-switch smoke failure'),
      }),
      expect.objectContaining({ action: 'rollback', id: 'previous', from: 'candidate', result: 'ok', automatic: true, runtimeId: 'previous' }),
    ]);
    expect(await release.report()).toMatchObject({
      commit: release.sha, result: 'rolled-back', version: 'candidate', previous: 'previous',
      benchmark: { passRate: 100, baseline: 100, tolerance: 10 },
    });

    await release.execute(...flags);
    expect(await release.active()).toBe('candidate');
    expect((await release.smokes()).at(-1)).toBe('/candidate-entry {}');
    expect((await release.log()).slice(-2)).toEqual([
      expect.objectContaining({ action: 'post-switch-smoke', result: 'ok', runtimeId: 'candidate' }),
      expect.objectContaining({ action: 'switch', id: 'candidate', previous: 'previous', result: 'ok', runtimeId: 'candidate' }),
    ]);
    expect(await release.report()).toMatchObject({ commit: release.sha, result: 'switched' });
  },
  30_000,
);
