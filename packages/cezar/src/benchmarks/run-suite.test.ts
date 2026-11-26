import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { artifactsDir, RunStore } from '../runs/store.ts';
import { writeRunScore } from '../scoring/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { benchmarkResults, readBenchmarkBatches, runBenchmarkSuite } from './run-suite.ts';

vi.mock('../self-update/run-version.ts', () => ({
  runHarnessVersion: async () => ({ id: 'test-release', commit: 'b'.repeat(40) }),
}));

it('reserves a bounded replay matrix and measures only the declared configurations and scorers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-benchmark-matrix-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const dataDir = join(root, '.ai/cezar');
  const store = RunStore.open(dataDir);
  try {
    git('init', '-qb', 'main');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-qm', 'fixture');
    const startCommit = git('rev-parse', 'HEAD');
    const tasks = new Map([['sample', {
      title: 'Fixture', workflow: 'quick-task', prompt: 'Read the example.', successCriteria: 'Identify the example.', startCommit,
    }]]);
    const startRun = vi.fn<RunManager['startRun']>((workflow, input, group) => {
      const run = store.createRun({ id: input.benchmarkRunId, title: 'Fixture', task: input.task,
        workflow: workflow.name, steps: [], groupId: group?.groupId, variant: group?.variant });
      store.updateRun(run.id, { replayChange: input.replay?.change });
      return run;
    });
    const project = { root, dataDir, store, manager: { startRun } as unknown as RunManager };
    const suite = { description: '', configurations: [
      { name: 'safe', runner: 'codex' as const, model: 'example-model' },
      { name: 'unsupported', runner: 'opencode' as const },
    ], tasks: ['sample'], scorers: ['outcome'], times: 2 };
    const result = await runBenchmarkSuite(project, 'smoke', suite, tasks);
    expect(result).toHaveProperty('batch');
    if ('reason' in result) throw new Error(result.reason);
    expect(startRun).toHaveBeenCalledTimes(2);
    expect(startRun.mock.calls[0]?.[1]).toMatchObject({
      model: 'example-model', readOnly: true, enforceReadOnly: true, worktree: true, secrets: [],
      replay: { startCommit, change: 'benchmark safe' },
    });
    expect(startRun.mock.calls[0]?.[2]?.groupId).toBe(startRun.mock.calls[1]?.[2]?.groupId);
    expect(readBenchmarkBatches(dataDir, 'smoke')).toEqual([result.batch]);
    expect(await runBenchmarkSuite(project, 'smoke', suite, tasks)).toHaveProperty('reason');
    const at = '2026-11-20T15:10:00.000Z';
    for (const [index, run] of store.listRuns().entries()) {
      store.updateRun(run.id, { status: 'done', startedAt: '2026-11-20T15:09:00.000Z', finishedAt: at, costUsd: index + 1 });
      writeRunScore(dataDir, run.id, 'outcome', {
        status: 'scored', finishedAt: at, score: { scorer: 'outcome', label: index ? 'delivered' : 'missed', pass: index > 0,
          score: index, reasoning: 'fixture', evidence: [], causes: [], judge: { runner: 'codex', transcriptChars: 10, shortened: false }, at },
      });
    }
    const summary = await benchmarkResults(project, result.batch);
    expect(summary.rows).toMatchObject([
      { name: 'safe', started: 2, failed: 1, passed: 1, meanWallMs: 60000, meanCostUsd: 1.5 },
      { name: 'unsupported', started: 0, unavailable: 1 },
    ]);
    if (!summary.artifact) throw new Error('No report artifact');
    expect(JSON.parse(await readFile(join(artifactsDir(dataDir, summary.artifact.runId), summary.artifact.name), 'utf8')).rows).toEqual(summary.rows);
    await rm(join(dataDir, 'artifacts'), { recursive: true, force: true });
    const stored = await benchmarkResults(project, result.batch);
    expect(stored.rows).toEqual(summary.rows);
    expect(stored).not.toHaveProperty('artifact');
  } finally {
    store.flush();
    await rm(root, { recursive: true, force: true });
  }
});
