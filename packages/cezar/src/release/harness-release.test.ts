import { execFile, execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const exec = promisify(execFile);

it.skipIf(process.platform === 'win32').each(['restart', 'health', 'manual', 'benchmark', 'post-switch'] as const)(
  'keeps a healthy release in the %s case',
  async (failure) => {
    const root = await mkdtemp(join(tmpdir(), 'cez-release-rollback-'));
    const workspace = join(root, 'workspace');
    const shimDir = join(root, 'commands');
    const scriptDir = join(root, 'scripts');
    const stateFile = join(workspace, 'active.txt');
    const server = createServer((_request, response) => response.end('{}'));
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing loopback listener');
      const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
      git('init', '-q');
      git('-c', 'user.name=Release Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture', '--allow-empty');
      const sha = git('rev-parse', 'HEAD');
      const candidate = join(workspace, 'factory', 'builds', sha.slice(0, 7), 'packages', 'cezar');
      const selfUpdate = join(candidate, 'dist', 'self-update');
      await Promise.all([
        mkdir(selfUpdate, { recursive: true }), mkdir(join(candidate, 'web', 'dist'), { recursive: true }),
        mkdir(shimDir), mkdir(scriptDir),
      ]);
      const service = join(shimDir, 'systemctl');
      const release = join(scriptDir, 'harness-release.mjs');
      await Promise.all([
        copyFile(new URL('../../../../scripts/harness-release.mjs', import.meta.url), release),
        writeFile(join(root, 'package.json'), '{"type":"module"}'),
        writeFile(stateFile, 'previous'),
        writeFile(join(candidate, 'dist', 'index.js'), ''),
        writeFile(join(selfUpdate, 'launcher.js'), 'export function writeLaunchers() {}'),
        writeFile(join(selfUpdate, 'layout.js'), `
          import { readFileSync, writeFileSync } from 'node:fs';
          export const activeId = () => readFileSync(process.env.RELEASE_TEST_STATE, 'utf8');
          export const activate = id => writeFileSync(process.env.RELEASE_TEST_STATE, id);
          export const linkCheckout = () => ({ id: 'candidate' });
          export const listLinks = () => [];
          export const versionEntry = id => '/' + id + '-entry';
          export const linkId = () => 'candidate';
        `),
        writeFile(service, failure === 'restart' ? '#!/bin/sh\ntest "$(cat "$RELEASE_TEST_STATE")" = previous\n' : '#!/bin/sh\nexit 0\n'),
      ]);
      await chmod(service, 0o755);
      const args = [release, sha, '--force', '--health-url', `http://127.0.0.1:${address.port}/api/v1/health`];
      if (failure === 'health') args.push('--simulate-unhealthy');
      const releaseLog = join(workspace, 'factory', 'release-log.ndjson');
      const execute = () => exec(process.execPath, args, {
        timeout: 10_000,
        env: { ...process.env, CEZ_HOME: workspace, RELEASE_TEST_STATE: stateFile, PATH: `${shimDir}:${process.env.PATH}` },
      });
      if (failure === 'manual') {
        const activePackage = join(workspace, 'versions', 'current', 'node_modules', '@open-mercato', 'cezar', 'dist', 'self-update');
        await mkdir(activePackage, { recursive: true });
        for (const file of ['layout.js', 'launcher.js']) await copyFile(join(selfUpdate, file), join(activePackage, file));
        const past = [
          { action: 'switch', id: 'previous', previous: 'stable', result: 'ok' },
          { action: 'switch', id: 'candidate', previous: 'previous', result: 'failed' },
          { action: 'rollback', id: 'previous', from: 'candidate', result: 'ok', automatic: true },
        ];
        await writeFile(releaseLog, past.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
        args.push('--rollback');
        await execute();
        expect(await readFile(stateFile, 'utf8')).toBe('stable');
        return;
      }
      if (failure === 'benchmark' || failure === 'post-switch') {
        const benchmarks = join(candidate, 'dist', 'benchmarks');
        const settings = join(candidate, 'dist', 'workspace');
        await Promise.all([mkdir(benchmarks), mkdir(settings)]);
        await Promise.all([
          writeFile(join(candidate, 'package.json'), '{"version":"0.1.0","type":"module"}'),
          writeFile(join(benchmarks, 'harness-smoke.js'), [
            'export const HARNESS_SMOKE_SUITE = "fixture";',
            'export const runHarnessSmokeSuite = async entry => ({ passRate: entry === "/previous-entry" ? 100 : ' +
              (failure === 'benchmark' ? 60 : 100) + ', samples: [] });',
          ].join('\n')),
          writeFile(join(settings, 'config.js'), 'export const loadWorkspaceConfig = async () => ({});'),
        ]);
        if (failure === 'post-switch') {
          await writeFile(join(selfUpdate, 'staging.js'), 'export const smokeStagedHarness = async () => { throw new Error("fixture failed"); };');
        }
        args.push('--benchmark');
      }
      await expect(execute()).rejects.toMatchObject({ code: 1 });
      expect(await readFile(stateFile, 'utf8')).toBe('previous');
      const log = (await readFile(releaseLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      if (failure === 'benchmark') {
        expect(log.at(-1)).toMatchObject({ action: 'benchmark', baseline: 100, passRate: 60, result: 'failed' });
        expect(log.some((entry) => entry.action === 'switch')).toBe(false);
        return;
      }
      expect(log.slice(-2)).toMatchObject([
        { action: 'switch', sha, id: 'candidate', previous: 'previous', result: 'failed' },
        { action: 'rollback', from: 'candidate', id: 'previous', result: 'ok', automatic: true },
      ]);
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
