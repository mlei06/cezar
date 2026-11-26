import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

/** Replay checks get workspace writes and private scratch space. Model credentials and the task
 * capability never reach the command, and a missing sandbox never falls back to Bash directly. */
export async function prepareReplayCheck(command: string) {
  if (process.platform !== 'linux') throw new Error('Replay checks require the Linux Codex sandbox.');
  // Dry-run mode still executes shell checks, so the bundled model mock cannot be the sandbox.
  const codex = process.env.CEZ_CODEX_BIN ?? 'codex';
  if (codex.includes('/') && !isAbsolute(codex)) throw new Error('The replay sandbox executable needs an absolute path.');
  const scratch = await mkdtemp(join(tmpdir(), 'cez-replay-check-'));
  const path = (process.env.PATH ?? '/usr/bin:/bin').split(delimiter).filter(isAbsolute).join(delimiter);
  return {
    file: '/bin/bash',
    args: [
      // libuv's stdio pipes may be Unix sockets. Use an anonymous pipe so a
      // sandboxed Node command can detect stdout with network access disabled.
      '--noprofile', '--norc', '-o', 'pipefail', '-c', '"$@" 2>&1 | /bin/cat', 'cez-replay-check',
      codex, 'sandbox',
      '-c', 'sandbox_mode="workspace-write"',
      '-c', 'sandbox_workspace_write.network_access=false',
      '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true',
      '-c', 'sandbox_workspace_write.exclude_slash_tmp=true',
      '-c', `sandbox_workspace_write.writable_roots=${JSON.stringify([scratch])}`,
      '-c', 'approval_policy="never"',
      '--', 'bash', '--noprofile', '--norc', '-c', command,
    ],
    env: { PATH: path, HOME: scratch, CODEX_HOME: scratch, TMPDIR: scratch },
    close: () => rm(scratch, { recursive: true, force: true }).catch(() => undefined),
  };
}
