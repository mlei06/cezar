import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PR_URL_RE, prNumberOfUrl } from '../server/forge/pr-url.ts';

/**
 * The diff of the pull request a task names, prepared by cezar before a review step runs.
 *
 * A read-only reviewer reads a PR through `gh pr diff`, which only knows GitHub: on Azure Repos
 * every reviewer reported "cannot see the change" and voted reject. And a prefix-checked shell
 * cannot be given `git diff` (`--output` writes any file). So cezar — trusted, outside the agent —
 * fetches the forge's merge ref (`refs/pull/<n>/merge`, which GitHub and Azure Repos both serve)
 * and writes the diff and its commits to a file the agent reads with Read.
 */

const GIT_TIMEOUT_MS = 60_000;
const MAX_DIFF = 2 * 1024 * 1024;

function git(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_DIFF * 2, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } },
      (error, stdout, stderr) => resolve({ ok: !error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }));
  });
}

/** The PR number when `text` is a review input: a PR URL, alone or leading the text. */
export function reviewedPrNumber(text: string): number | undefined {
  const match = PR_URL_RE.exec(text.trim());
  return match && text.trim().startsWith(match[0]) ? prNumberOfUrl(match[0]) : undefined;
}

export type PrDiff = { ok: true; path: string; number: number; files: number } | { ok: false; reason: string };

/** Fetch PR `number`'s merge ref from `origin` and write `pr-<n>.diff` into `dir`. */
export async function preparePrDiff(repoRoot: string, number: number, dir: string): Promise<PrDiff> {
  const ref = `refs/cezar/review/${number}`;
  const fetched = await git(repoRoot, ['-c', 'protocol.version=2', 'fetch', '--no-tags', '--quiet', 'origin', `+refs/pull/${number}/merge:${ref}`]);
  if (!fetched.ok) return { ok: false, reason: `the forge has no merge ref for PR ${number} (conflicted, closed, or not this repository): ${fetched.stderr.trim().split('\n')[0] ?? ''}` };
  const [log, stat, diff] = await Promise.all([
    git(repoRoot, ['log', '--no-ext-diff', '--oneline', '--no-decorate', `${ref}^1..${ref}^2`]),
    git(repoRoot, ['diff', '--no-ext-diff', '--no-textconv', '--stat', `${ref}^1`, ref]),
    git(repoRoot, ['diff', '--no-ext-diff', '--no-textconv', `${ref}^1`, ref]),
  ]);
  if (!diff.ok) return { ok: false, reason: `git diff failed for PR ${number}` };
  const body = diff.stdout.length > MAX_DIFF ? `${diff.stdout.slice(0, MAX_DIFF)}\n… diff truncated at ${MAX_DIFF} bytes\n` : diff.stdout;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `pr-${number}.diff`);
  writeFileSync(path, `# Pull request ${number}: the change as merged into its target (merge ref ${ref})\n# Commits\n${log.stdout}\n# Files\n${stat.stdout}\n${body}`, { mode: 0o600 });
  const files = (stat.stdout.match(/\|/g) ?? []).length;
  return { ok: true, path, number, files };
}
