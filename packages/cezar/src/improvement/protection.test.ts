import { expect, it } from 'vitest';
import { isProtectedPath, protectedChanges } from './protection.ts';

it('names the owner-protected paths and nothing else', () => {
  for (const path of ['.ai/cezar/scorers/outcome/scorer.md', './.ai/cezar/workflows/improve-factory.yaml',
    '.ai/cezar/workflows/harness-release.yml', 'packages/cezar/skills/improve-factory/SKILL.md', '.ai/skills/improve-factory/run.sh']) {
    expect(isProtectedPath(path), path).toBe(true);
  }
  for (const path of ['.ai/cezar/workflows/deploy.yaml', 'packages/cezar/src/scoring/judge.ts', 'docs/scorers.md', 'skills/improve-factory-notes.md']) {
    expect(isProtectedPath(path), path).toBe(false);
  }
  expect(protectedChanges([{ path: 'a.ts' }, { path: 'b.md', previousPath: '.ai/cezar/scorers/x.md' }, { path: '.ai/cezar/scorers/x.md' }]))
    .toEqual(['.ai/cezar/scorers/x.md']);
});
