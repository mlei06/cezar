import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { preparePrDiff, reviewedPrNumber } from './pr-diff.ts';

const g = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });

describe('the reviewed PR diff, on any forge (pr-diff.ts)', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it('reads a PR number only from a review input that starts with the PR URL', () => {
    expect(reviewedPrNumber('https://dev.azure.com/acme/Shop/_git/web/pullrequest/5')).toBe(5);
    expect(reviewedPrNumber('https://github.com/acme/web/pull/12 focus on auth')).toBe(12);
    expect(reviewedPrNumber('Fix the bug in https://github.com/acme/web/pull/12')).toBeUndefined();
  });

  it('fetches refs/pull/<n>/merge and writes the commits, files and diff', async () => {
    const origin = mkdtempSync(join(tmpdir(), 'cez-prdiff-origin-'));
    const repo = mkdtempSync(join(tmpdir(), 'cez-prdiff-repo-'));
    const out = mkdtempSync(join(tmpdir(), 'cez-prdiff-out-'));
    dirs.push(origin, repo, out);
    g(origin, 'init', '-q', '-b', 'main');
    writeFileSync(join(origin, 'a.txt'), 'one\n');
    g(origin, 'add', '-A'); g(origin, 'commit', '-q', '-m', 'base');
    g(origin, 'switch', '-q', '-c', 'feature');
    writeFileSync(join(origin, 'a.txt'), 'two\n');
    g(origin, 'commit', '-q', '-am', 'change a');
    g(origin, 'switch', '-q', 'main');
    g(origin, 'merge', '-q', '--no-ff', '--no-commit', 'feature');
    const tree = g(origin, 'write-tree').trim();
    const merge = g(origin, 'commit-tree', tree, '-p', 'main', '-p', 'feature', '-m', 'merge').trim();
    g(origin, 'merge', '--abort');
    g(origin, 'update-ref', 'refs/pull/7/merge', merge);
    g(repo, 'clone', '-q', origin, '.');

    const prepared = await preparePrDiff(repo, 7, out);
    expect(prepared).toMatchObject({ ok: true, number: 7, files: 1 });
    const text = readFileSync((prepared as { path: string }).path, 'utf8');
    expect(text).toContain('change a');
    expect(text).toContain('-one');
    expect(text).toContain('+two');
    expect(await preparePrDiff(repo, 8, out)).toMatchObject({ ok: false });
  });
});
