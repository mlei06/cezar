/**
 * The built-in Plan workflow's one shell read (factory observations A-5, C-2): a tracked file at a
 * git ref, as exactly `git show <ref>:<path>`. Codex's broker and Claude's PreToolUse hook both
 * validate each call with `isGitShowAtRefArgv`; no other flag, operand or command passes.
 */
import { existsSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenizePlainShell } from './plain-shell.ts';

/** A `bashAllowlist` entry: a grant name, never a prefix rule a backend may pass on as is. */
export const GIT_SHOW_AT_REF = 'git show <ref>:<path>';

// A ref never starts with `-` (an option) or `:` (the index); the path is any non-empty tree path.
const OBJECT = /^[A-Za-z0-9_@][A-Za-z0-9._/@{}~^+-]*:[^\x00-\x1f]+$/;

export function isGitShowAtRefArgv(argv: readonly string[]): boolean {
  return argv.length === 3 && argv[0] === 'git' && argv[1] === 'show' && OBJECT.test(argv[2]!);
}

/** Whether a step's shell grant is this one read and nothing else. */
export function isGitShowAtRefOnly(bashAllowlist: readonly string[] | undefined): boolean {
  return bashAllowlist?.length === 1 && bashAllowlist[0] === GIT_SHOW_AT_REF;
}

/** Claude's answer for one Bash call under this grant: the exact shape, or deny. */
export function gitShowAtRefHookDecision(command: unknown): { decision: 'allow' | 'deny'; reason: string } {
  if (typeof command !== 'string' || command.length > 16_000) return { decision: 'deny', reason: 'no command' };
  const parsed = tokenizePlainShell(command.trim());
  if (typeof parsed === 'string') return { decision: 'deny', reason: `cezar read grant: refused shell syntax: ${parsed}` };
  if (parsed.length === 1 && isGitShowAtRefArgv(parsed[0]!)) return { decision: 'allow', reason: 'cezar read grant: git show <ref>:<path>' };
  return { decision: 'deny', reason: 'cezar read grant: the only shell command here is `git show <ref>:<path>`, with no flags' };
}

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/** The hook's shell command; `|| exit 2` turns a hook that cannot start into a block. */
export function gitShowAtRefHookCommand(): string | undefined {
  if (process.platform === 'win32') return undefined;
  const self = fileURLToPath(import.meta.url);
  const hook = join(dirname(self), `read-grant-hook${extname(self)}`);
  if (!existsSync(hook)) return undefined;
  const flags = process.execArgv.filter((arg) => !arg.startsWith('--inspect'));
  return `${[process.execPath, ...flags, hook].map(shellQuote).join(' ')} || exit 2`;
}
