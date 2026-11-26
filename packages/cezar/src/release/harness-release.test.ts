import { execFile, execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const exec = promisify(execFile);

it.skipIf(process.platform === 'win32').each(['restart', 'health', 'manual', 'benchmark', 'post-switch', 'revert', 'unmerged', 'validation'] as const)(
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
      git('init', '-q', '-b', 'factory');
      const commit = (...args: string[]) => git(
        '-c', 'user.name=Release Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgSign=false', 'commit', ...args,
      );
      const payload = join(root, 'version.txt');
      if (failure === 'revert') {
        await writeFile(payload, 'stable\n');
        git('add', 'version.txt');
      }
      commit('-qm', 'fixture', '--allow-empty');
      if (failure === 'revert') {
        await writeFile(payload, 'changed\n');
        commit('-qam', 'release change');
      }
      if (failure !== 'manual' && failure !== 'revert') {
        const remote = join(root, 'remote.git');
        git('init', '-q', '--bare', remote);
        git('remote', 'add', 'origin', remote);
        git('push', 'origin', 'HEAD:refs/heads/factory');
        if (failure === 'unmerged') commit('-qm', 'unmerged candidate', '--allow-empty');
      }
      const sha = git('rev-parse', 'HEAD');
      const candidate = join(workspace, 'factory', 'builds', sha.slice(0, 7), 'packages', 'cezar');
      const selfUpdate = join(candidate, 'dist', 'self-update');
      await Promise.all([
        mkdir(selfUpdate, { recursive: true }), mkdir(join(candidate, 'web', 'dist'), { recursive: true }),
        mkdir(shimDir), mkdir(scriptDir),
      ]);
      const service = join(shimDir, 'systemctl');
      const npm = join(shimDir, 'npm');
      const checksLog = join(workspace, 'checks.log');
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
        writeFile(npm, [
          '#!/bin/sh',
          'printf "%s\\n" "$*" >> "$RELEASE_TEST_CHECKS"',
          failure === 'validation' ? 'test "$*" != "run test:unit"' : 'exit 0',
        ].join('\n')),
      ]);
      await Promise.all([chmod(service, 0o755), chmod(npm, 0o755)]);
      const args = [release, sha, '--force', '--health-url', `http://127.0.0.1:${address.port}/api/v1/health`];
      if (failure === 'health') args.push('--simulate-unhealthy');
      const releaseLog = join(workspace, 'factory', 'release-log.ndjson');
      const execute = () => exec(process.execPath, args, {
        timeout: 10_000,
        env: {
          ...process.env, CEZ_HOME: workspace, RELEASE_TEST_STATE: stateFile, RELEASE_TEST_CHECKS: checksLog,
          PATH: `${shimDir}:${process.env.PATH}`,
        },
      });
      if (failure === 'manual' || failure === 'revert') {
        const activePackage = join(workspace, 'versions', 'current', 'node_modules', '@open-mercato', 'cezar', 'dist', 'self-update');
        await mkdir(activePackage, { recursive: true });
        for (const file of ['layout.js', 'launcher.js']) await copyFile(join(selfUpdate, file), join(activePackage, file));
        const past = [
          { action: 'switch', id: 'previous', previous: 'stable', result: 'ok', ...(failure === 'revert' ? { sha } : {}) },
          { action: 'switch', id: 'candidate', previous: 'previous', result: 'failed' },
          { action: 'rollback', id: 'previous', from: 'candidate', result: 'ok', automatic: true },
        ];
        await writeFile(releaseLog, past.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
        const remote = join(root, 'remote.git');
        const forge = join(shimDir, 'gh');
        if (failure === 'revert') {
          git('init', '-q', '--bare', remote);
          const origin = 'https://github.com/example/harness.git';
          git('remote', 'add', 'origin', origin);
          git('config', 'url.file://' + remote + '.insteadOf', origin);
          git('push', 'origin', 'HEAD:refs/heads/factory');
          await writeFile(join(activePackage, '..', 'git-remotes.js'),
            'export const parseRemote = () => ({ host: "github.com", owner: "example", repo: "harness" });');
          await writeFile(forge, [
            '#!/bin/sh',
            'case "$1 $2" in',
            '  "pr list") echo "[]";;',
            '  "api user") echo \'{"id":123,"login":"fixture"}\';;',
            '  "pr create") printf "%s\\n" "$@" > "$0.argv"; echo "https://github.com/example/harness/pull/1";;',
            '  *) exit 1;;',
            'esac',
          ].join('\n'));
          await chmod(forge, 0o755);
        }
        args.push('--rollback');
        await execute();
        expect(await readFile(stateFile, 'utf8')).toBe('stable');
        if (failure === 'revert') {
          const branch = 'revert/harness-' + sha.slice(0, 12);
          expect(git('--git-dir', remote, 'show', branch + ':version.txt')).toBe('stable');
          const pr = (await readFile(forge + '.argv', 'utf8')).trim().split('\n');
          expect(pr).toEqual(expect.arrayContaining(['--base', 'factory', '--head', branch, '--draft']));
          expect(pr).toContain('github.com/example/harness');
          expect(git('--git-dir', remote, 'log', '-1', '--format=%ae', branch)).toBe('123+fixture@users.noreply.github.com');
        }
        return;
      }
      if (failure === 'benchmark' || failure === 'post-switch' || failure === 'validation') {
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
      if (failure === 'unmerged') {
        expect(log).toEqual([expect.objectContaining({ action: 'switch', result: 'failed', reason: 'The candidate is not merged into origin/factory.' })]);
        return;
      }
      if (failure === 'validation') {
        expect((await readFile(checksLog, 'utf8')).trim().split('\n')).toEqual(['run typecheck', 'test', 'run test:unit']);
        expect(log).toEqual([
          expect.objectContaining({ action: 'build', sha, result: 'started' }),
          expect.objectContaining({ action: 'build', sha, result: 'failed', reason: 'npm run test:unit failed (exit 1)' }),
        ]);
        return;
      }
      if (failure === 'benchmark') {
        expect((await readFile(checksLog, 'utf8')).trim().split('\n')).toEqual([
          'run typecheck', 'test', 'run test:unit', 'run build', 'run test:package',
        ]);
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
