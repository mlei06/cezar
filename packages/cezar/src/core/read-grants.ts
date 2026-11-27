/**
 * The built-in Plan workflow's one shell read (factory observations A-5, C-2): a tracked file at a
 * git ref, asked for as exactly `git show <ref>:<path>`. Only Codex's read broker honors it, and it
 * runs the read itself as fixed `git cat-file` argv (`codex-restricted-tools.ts`); every other
 * backend keeps Plan's shell denied.
 */

/** A `bashAllowlist` entry: a grant name, never a prefix rule a backend may pass on as is. */
export const GIT_SHOW_AT_REF = 'git show <ref>:<path>';

// A ref never starts with `-` (an option) or `:` (the index); the path is any non-empty tree path.
const OBJECT = /^[A-Za-z0-9_@][A-Za-z0-9._/@{}~^+-]*:[^\x00-\x1f]+$/;

export function isGitShowAtRefArgv(argv: readonly string[]): boolean {
  return argv.length === 3 && argv[0] === 'git' && argv[1] === 'show' && OBJECT.test(argv[2]!);
}
