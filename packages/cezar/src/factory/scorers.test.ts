import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { checkFactory } from './check.ts';
import { parseScorer, ScorerCatalog, SCORERS_DIR } from './scorers.ts';

const rubric = (pass = 1, workflows = '[quick-task]') => `---
description: Test the task outcome
workflows: ${workflows}
labels:
  - { value: yes, score: 1, description: matched the brief }
  - { value: no, score: 0, description: did not match the brief }
passingScore: ${pass}
---
Quote one line before choosing.
`;

it('requires a passing and a failing label, and otherwise keeps the rubric as written', () => {
  const valid = parseScorer('example', rubric(), 'project');
  expect(valid).toMatchObject({ passingScore: 1, samplingRate: 100, rubric: 'Quote one line before choosing.\n' });
  expect(() => parseScorer('example', rubric(0), 'project')).toThrow('one passing and one failing label');
});

it('loads the bundled rubrics and retains a valid project override while an edit is invalid', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-scorers-'));
  try {
    const project = join(root, SCORERS_DIR, 'outcome');
    const file = join(project, 'scorer.md');
    await mkdir(project, { recursive: true });
    const names = new Set(['quick-task']);
    const catalog = new ScorerCatalog();
    await writeFile(file, rubric());
    const first = await catalog.load(root, names);
    expect(first.issues).toEqual([]);
    expect(first.scorers.map((scorer) => [scorer.name, scorer.source])).toEqual([
      ['efficiency', 'builtin'], ['outcome', 'project'], ['procedure', 'builtin'], ['scope', 'builtin'],
    ]);

    await writeFile(file, rubric(1, '[missing-workflow]'));
    const invalid = await catalog.load(root, names);
    expect(invalid.issues).toEqual([{ path: file, message: 'Unknown workflows: missing-workflow.' }]);
    expect(invalid.scorers).toEqual(first.scorers);

    await rm(file);
    const removed = await catalog.load(root, names);
    expect(removed.issues).toEqual([]);
    expect(removed.scorers.find((scorer) => scorer.name === 'outcome')?.source).toBe('builtin');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('keeps the last valid rubric across a restart until the override is removed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-scorer-cache-'));
  vi.stubEnv('CEZ_HOME', join(root, 'workspace'));
  try {
    const dir = join(root, SCORERS_DIR, 'example');
    const file = join(dir, 'scorer.md');
    const names = new Set(['quick-task']);
    await mkdir(dir, { recursive: true });
    await writeFile(file, rubric());
    const first = await new ScorerCatalog(true).load(root, names);

    await writeFile(file, rubric(0));
    const restarted = await new ScorerCatalog(true).load(root, names);
    expect(restarted.issues).toHaveLength(1);
    expect(restarted.scorers).toEqual(first.scorers);

    await rm(file);
    await new ScorerCatalog(true).load(root, names);
    await writeFile(file, rubric(0));
    const afterRemoval = await new ScorerCatalog(true).load(root, names);
    expect(afterRemoval.issues).toHaveLength(1);
    expect(afterRemoval.scorers.some((item) => item.name === 'example')).toBe(false);
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});

it('reports unknown workflow skills and invalid scorers from the factory check', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-factory-check-'));
  try {
    await mkdir(join(root, '.ai/cezar/workflows'), { recursive: true });
    await writeFile(join(root, '.ai/cezar/workflows/example.yaml'), 'name: example\nsteps:\n  - id: run\n    skill: absent-fixture-skill\n');
    const project = join(root, SCORERS_DIR, 'example');
    await mkdir(project, { recursive: true });
    await writeFile(join(project, 'scorer.md'), rubric(0));
    const issues = await checkFactory(root);
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining('unknown skill absent-fixture-skill') }),
      expect.objectContaining({ message: expect.stringContaining('one passing and one failing label') }),
    ]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
