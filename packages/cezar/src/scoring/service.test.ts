import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { runScoreCommand } from './cli.ts';
import { JUDGE_OUTAGE_RETRY_MS, type JudgeCall } from './evaluate.ts';
import { ScoringService } from './service.ts';
import { readRunScores, writeRunScore } from './store.ts';

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

it('recovers an interrupted judge queue from the persisted retry deadline', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-score-retry-'));
  const dataDir = join(root, '.ai/cezar');
  vi.stubEnv('CEZ_HOME', join(root, 'workspace'));
  vi.stubEnv('CEZ_DRY_RUN', '0');
  vi.stubEnv('CEZ_SCORING', '1');
  const store = RunStore.open(dataDir);
  const at = new Date().toISOString();
  const run = store.createRun({ title: 'Fixture', task: 'Run the check.', workflow: 'quick-task', steps: [] });
  store.updateRun(run.id, { status: 'done', startedAt: at, finishedAt: at });
  store.appendEvent(run.id, { type: 'text', text: 'Check passed.' });
  writeRunScore(dataDir, run.id, 'outcome', { status: 'pending', finishedAt: at, retryAt: at, outages: 1 });
  const call = vi.fn<JudgeCall>().mockResolvedValue({ unavailable: true });
  const service = new ScoringService(vi.fn(), async () => ({ runner: 'codex', call }));
  const project = { id: 'example', root, dataDir, store };
  const off = service.watch(project);
  try {
    const pending = await vi.waitFor(() => {
      const value = readRunScores(dataDir, run.id).outcome;
      expect(value).toMatchObject({ status: 'pending', outages: 2 });
      if (value?.status !== 'pending') throw new Error('Expected a persisted retry');
      return value;
    });
    expect(Date.parse(pending.retryAt) - Date.now()).toBeGreaterThan(JUDGE_OUTAGE_RETRY_MS[1] - 1000);
    expect(call).toHaveBeenCalledTimes(1);
    off();
    service.dispose();

    // Restart after the deadline. Only the interrupted scorer is replayed.
    writeRunScore(dataDir, run.id, 'outcome', { ...pending, retryAt: at });
    call.mockResolvedValue({ text: JSON.stringify({ label: 'delivered', reasoning: 'Passed', evidence: ['Check passed.'] }) });
    const restarted = new ScoringService(vi.fn(), async () => ({ runner: 'codex', call }));
    const detach = restarted.watch(project);
    try {
      await vi.waitFor(() => expect(readRunScores(dataDir, run.id)).toMatchObject({
        outcome: { status: 'scored', score: { pass: true, evidence: ['Check passed.'] } },
      }));
      expect(Object.keys(readRunScores(dataDir, run.id))).toEqual(['outcome']);
      expect(call).toHaveBeenCalledTimes(2);
    } finally {
      detach();
      restarted.dispose();
    }
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
