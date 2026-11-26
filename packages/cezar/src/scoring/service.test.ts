import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { runScoreCommand } from './cli.ts';
import type { JudgeCall } from './evaluate.ts';
import { ScoringService } from './service.ts';
import { readRunScores } from './store.ts';

it('scores a newly settled task, obeys sample settings, and supports an explicit re-score', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-score-service-'));
  const dataDir = join(root, '.ai/cezar');
  vi.stubEnv('CEZ_HOME', join(root, 'home'));
  vi.stubEnv('CEZ_DRY_RUN', '0');
  vi.stubEnv('CEZ_SCORING', '1');
  const onScore = vi.fn();
  const call = vi.fn<JudgeCall>(async ({ systemPrompt }) => {
    const labels = JSON.parse(systemPrompt.match(/Allowed labels: (.*)/)?.[1] ?? '[]') as Array<{ value: string }>;
    return { text: JSON.stringify({ label: labels[0]?.value, reasoning: 'Fixture verdict', evidence: ['Observed result.'] }) };
  });
  const service = new ScoringService(onScore, async () => ({ runner: 'codex', call }));
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ factory: { scoring: { sampling: { scope: 0 } } } }));
  const store = RunStore.open(dataDir);
  const project = { id: 'example', root, dataDir, store };
  const off = service.watch(project);
  try {
    const run = store.createRun({ title: 'Fixture', task: 'Run a check.', workflow: 'quick-task', steps: [] });
    const at = new Date().toISOString();
    store.updateRun(run.id, { status: 'running', startedAt: at });
    store.appendEvent(run.id, { type: 'text', text: 'Observed result.' });
    store.updateRun(run.id, { status: 'review', finishedAt: at });
    await vi.waitFor(() => expect(onScore).toHaveBeenCalledTimes(3));
    expect(readRunScores(dataDir, run.id)).toMatchObject({
      outcome: { status: 'scored', score: { evidence: ['Observed result.'] } },
      efficiency: { status: 'scored' },
      procedure: { status: 'scored' },
    });
    store.updateRun(run.id, { status: 'done' });
    expect(await service.rescore(project, run, 'scope')).toEqual({ queued: ['scope'] });
    await vi.waitFor(() => expect(onScore).toHaveBeenCalledTimes(4));
    expect(Object.keys(readRunScores(dataDir, run.id))).toHaveLength(4);
  } finally {
    off();
    service.dispose();
    store.flush();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});

it('queues an explicitly selected scorer through the current project', async () => {
  const fetcher = vi.fn(async () => Response.json({ queued: ['outcome'] }, { status: 202 }));
  expect(await runScoreCommand(['task-1', '--scorer', 'outcome'], process.cwd(), {
    CEZ_API_URL: 'http://example.invalid', CEZ_PROJECT_ID: 'fixture',
  }, { fetch: fetcher, log: vi.fn(), error: vi.fn() })).toBe(0);
  expect(fetcher).toHaveBeenCalledWith('http://example.invalid/api/v1/p/fixture/runs/task-1/score',
    expect.objectContaining({ method: 'POST', body: '{"scorer":"outcome"}' }));
});
