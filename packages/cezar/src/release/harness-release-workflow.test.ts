import { execFile, execFileSync } from 'node:child_process';
import { appendFile, chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const exec = promisify(execFile);

it.skipIf(process.platform === 'win32')('schedules only the merged, benchmarked release in a detached unit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-release-workflow-'));
  try {
    const scripts = join(root, 'scripts');
    const commands = join(root, 'commands');
    await Promise.all([mkdir(scripts), mkdir(commands)]);
    const schedule = join(scripts, 'schedule-harness-release.mjs');
    const release = join(scripts, 'harness-release.mjs');
    const shim = join(commands, 'systemd-run');
    await Promise.all([
      copyFile(new URL('../../../../scripts/schedule-harness-release.mjs', import.meta.url), schedule),
      copyFile(new URL('../../../../scripts/harness-release.mjs', import.meta.url), release),
      writeFile(shim, '#!/bin/sh\nprintf "%s\\n" "$@" > "$0.argv"\n'),
    ]);
    await chmod(shim, 0o755);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'factory');
    git('add', 'scripts');
    git('-c', 'user.name=Release Test', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'fixture');
    git('remote', 'add', 'origin', root);
    const sha = git('rev-parse', 'HEAD');
    const env = {
      ...process.env, PATH: commands + ':' + process.env.PATH, CEZ_DRY_RUN: '0', CEZ_REMOTE: '0',
      CEZ_SUPERVISED: '1', CEZ_RUN_ID: 'test-run', CEZ_API_URL: 'http://127.0.0.1:4999', CEZ_HOME: join(root, 'isolated-home'),
    };
    const launch = () => exec(process.execPath, [schedule], { cwd: root, env, timeout: 8000 });
    await launch();
    const args = (await readFile(shim + '.argv', 'utf8')).trim().split('\n');
    expect(args).toContain('--unit=harness-release-' + sha.slice(0, 7));
    expect(args.slice(-7)).toEqual([
      process.execPath, release, sha, '--benchmark', '--hold-new-tasks',
      '--health-url', 'http://127.0.0.1:4999/api/v1/health',
    ]);

    await rm(shim + '.argv');
    await appendFile(release, '\n// Unmerged local edit.\n');
    await expect(launch()).rejects.toMatchObject({ code: 1 });
    await expect(readFile(shim + '.argv')).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
