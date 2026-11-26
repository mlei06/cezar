import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { changedModelWorkflow, checkImprovementBenchmarks } from './benchmarks.ts';

it('revalidates changed agent selection without treating prompt or comments as routing changes', () => {
  const before = 'name: operate\nsteps:\n- id: task\n  model: routine-old\n  prompt: Check status.\n';
  expect(changedModelWorkflow(before, before.replace('Check status.', 'Find the status.'))).toBeUndefined();
  expect(changedModelWorkflow(before, before.replace('routine-old', 'routine-new'))).toBe('operate');
  expect(changedModelWorkflow(undefined, before)).toBe('operate');
  expect(changedModelWorkflow(before, undefined)).toBe('operate');
  expect(changedModelWorkflow('name: verify\nnodes:\n- {id: only, type: check}', 'name: verify\nnodes:\n- {id: only, type: check, model: example}'))
    .toBeUndefined();
});

it('holds a committed model change until the project has a matching saved benchmark', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-improvement-model-check-'));
  const projectDir = join(root, 'project');
  const candidateDir = join(root, 'candidate');
  const dataDir = join(projectDir, '.ai/cezar');
  mkdirSync(join(dataDir, 'workflows'), { recursive: true });
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const path = '.ai/cezar/workflows/operate.yaml';
  const fixture = (model: string) => 'name: operate\nsteps:\n- {id: inspect, model: ' + model + ', prompt: Inspect.}\n';
  const store = RunStore.open(dataDir);
  try {
    git(projectDir, 'init', '-qb', 'main');
    writeFileSync(join(projectDir, path), fixture('routine-old'));
    git(projectDir, 'add', '--', path);
    git(projectDir, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'baseline');
    const start = git(projectDir, 'rev-parse', 'HEAD');
    git(projectDir, 'worktree', 'add', '-qb', 'candidate', candidateDir);
    writeFileSync(join(candidateDir, path), fixture('routine-new'));
    git(candidateDir, 'add', '--', path);
    git(candidateDir, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'candidate');
    const run = store.createRun({ title: 'Fixture', workflow: 'improve-factory', task: 'Update a model', steps: [] });
    run.startCommit = start;
    const check = await checkImprovementBenchmarks({
      project: { root: projectDir, dataDir, store, manager: {} as RunManager },
      cwd: candidateDir, run, cancelled: () => false,
    });
    expect(check).toEqual({ ok: false, output: 'Add a saved benchmark for each workflow whose agent selection changed.' });
  } finally {
    store.flush();
    rmSync(root, { recursive: true, force: true });
  }
});
