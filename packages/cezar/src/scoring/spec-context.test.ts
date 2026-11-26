import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { referencedSpecContext } from './spec-context.ts';

it('gives scope only the cited decision from the original commit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-spec-context-'));
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    git('init', '-q');
    await mkdir(join(root, '.ai/specs'), { recursive: true });
    const file = '.ai/specs/example.md';
    await writeFile(join(root, file), '### D4. Budget\nDo not read this.\n### D5. Scope\nOriginal evidence.\n#### Detail\nKeep this.\n### D6. Routes\nSkip this too.\n');
    git('add', file);
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
    const startCommit = git('rev-parse', 'HEAD');
    await writeFile(join(root, file), '### D5. Scope\nChanged working copy.\n');
    expect(await referencedSpecContext(root, { startCommit, task: 'Implement .ai/specs/example.md D5.' }))
      .toBe([file, '### D5. Scope', 'Original evidence.', '#### Detail', 'Keep this.'].join('\n'));
    expect(await referencedSpecContext(root, { startCommit, task: 'Read .ai/specs/example.md for context.' })).toBeUndefined();
    expect(await referencedSpecContext(root, { startCommit, task: 'Read ../.ai/specs/example.md D5.' })).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
