import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { resolveProgram } from '../core/codex-restricted-tools.ts';

/** A named profile bounds reads and writes as well as disabling network. A CLI that
 * cannot apply the profile exits before it runs the check. */
export async function prepareReplayCheck(command: string, cwd: string) {
  if (process.platform !== 'linux') throw new Error('Replay checks require the Linux Codex sandbox.');
  const path = (process.env.PATH ?? '/usr/bin:/bin').split(delimiter).filter(isAbsolute).join(delimiter);
  // Dry-run still executes shell checks. Its model mock cannot enforce the sandbox.
  const executable = resolveProgram(process.env.CEZ_CODEX_BIN ?? 'codex', { PATH: path });
  if (!executable) throw new Error('No Codex executable was found to sandbox replay checks.');
  const [codex, worktree, node] = await Promise.all([
    realpath(executable), realpath(cwd), realpath(process.execPath),
  ]);
  const scratch = await mkdtemp(join(tmpdir(), 'cez-replay-check-'));
  const close = () => rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  try {
    const filesystem = new Map([
      [':minimal', 'read'], [codex, 'read'], [node, 'read'],
      [worktree, 'write'], [join(worktree, '.git'), 'deny'], [scratch, 'write'],
    ]);
    await writeFile(join(scratch, 'config.toml'), [
      'approval_policy = "never"',
      '[permissions.replay.filesystem]',
      ...Array.from(filesystem, ([key, access]) => `${JSON.stringify(key)} = "${access}"`),
      '[permissions.replay.network]',
      'enabled = false',
    ].join('\n'), { mode: 0o600 });
    return {
      file: '/bin/bash',
      args: [
        // Use an anonymous pipe so a sandboxed Node command can detect stdout
        // without libuv trying to inspect a Unix socket.
        '--noprofile', '--norc', '-o', 'pipefail', '-c', '"$@" 2>&1 | /bin/cat', 'cez-replay-check',
        // Resolve the profile from scratch, before any project config can shadow it.
        codex, 'sandbox', '--permission-profile', 'replay', '--cd', scratch, '--',
        '/usr/bin/env', `TMPDIR=${scratch}`, '/bin/bash', '--noprofile', '--norc', '-c',
        'cd -- "$1" && exec /bin/bash --noprofile --norc -c "$2"', 'cez-replay-check', worktree, command,
      ],
      env: { PATH: path, HOME: scratch, CODEX_HOME: scratch },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
