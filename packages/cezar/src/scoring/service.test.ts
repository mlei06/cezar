import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { SecretStore } from '../workspace/secrets.ts';
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

it('scores tasks settled during startup recovery without backfilling older finished tasks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-score-startup-'));
  const dataDir = join(root, '.ai/cezar');
  vi.stubEnv('CEZ_HOME', join(root, 'workspace'));
  vi.stubEnv('CEZ_DRY_RUN', '0');
  vi.stubEnv('CEZ_SCORING', '1');
  const store = RunStore.open(dataDir);
  const recoveredSince = Date.now() - 500;
  const makeFinished = (when: number) => {
    const timestamp = new Date(when).toISOString();
    const run = store.createRun({ title: 'Fixture', task: 'Run the check.', workflow: 'quick-task', steps: [] });
    store.updateRun(run.id, { status: 'done', startedAt: timestamp, finishedAt: timestamp });
    return run.id;
  };
  const older = makeFinished(recoveredSince - 1000);
  const recovered = makeFinished(recoveredSince + 250);
  const call = vi.fn<JudgeCall>(async ({ systemPrompt }) => {
    const labels = JSON.parse(systemPrompt.match(/Allowed labels: (.*)/)?.[1] ?? '[]') as Array<{ value: string }>;
    return { text: JSON.stringify({ label: labels[0]?.value, reasoning: 'Fixture verdict' }) };
  });
  const service = new ScoringService(vi.fn(), async () => ({ runner: 'codex', call }));
  const off = service.watch({ id: 'example', root, dataDir, store }, recoveredSince);
  try {
    await vi.waitFor(() => expect(Object.values(readRunScores(dataDir, recovered)).filter((score) => score.status === 'scored')).toHaveLength(4));
    expect(readRunScores(dataDir, older)).toEqual({});
    expect(call).toHaveBeenCalledTimes(4);
  } finally {
    off();
    service.dispose();
    store.flush();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});

it('reconciles saved verdicts for the current settlement without calling the judge again', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-recover-verdicts-'));
  const dataDir = join(root, '.ai/cezar');
  vi.stubEnv('CEZ_HOME', join(root, 'workspace'));
  vi.stubEnv('CEZ_DRY_RUN', '0');
  vi.stubEnv('CEZ_SCORING', '1');
  const store = RunStore.open(dataDir);
  const project = { id: 'example', root, dataDir, store };
  const at = new Date().toISOString();
  const run = store.createRun({ title: 'Fixture', task: 'Run the check.', workflow: 'quick-task', steps: [] });
  store.updateRun(run.id, { status: 'done', startedAt: at, finishedAt: at });
  const score = {
    scorer: 'outcome', label: 'delivered', score: 1, pass: true, reasoning: 'Recorded verdict', evidence: [], causes: [],
    judge: { runner: 'codex' as const, transcriptChars: 10, shortened: false }, at,
  };
  writeRunScore(dataDir, run.id, 'outcome', { status: 'scored', finishedAt: at, score });
  writeRunScore(dataDir, run.id, 'efficiency', { status: 'scored', finishedAt: '2026-01-01T00:00:00.000Z', score: {
    ...score, scorer: 'efficiency',
  } });
  const judge = vi.fn();
  const reconcile = vi.fn();
  const service = new ScoringService(vi.fn(), judge, undefined, reconcile);
  const off = service.watch(project);
  try {
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledWith(project, [{ run, score }]));
    expect(judge).not.toHaveBeenCalled();
  } finally {
    off();
    service.dispose();
    store.flush();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});

it('publishes pending and error invalidations and removes an older outcome summary on re-score', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-score-state-'));
  const dataDir = join(root, '.ai/cezar');
  vi.stubEnv('CEZ_HOME', join(root, 'workspace'));
  vi.stubEnv('CEZ_DRY_RUN', '0');
  vi.stubEnv('CEZ_SCORING', '1');
  const store = RunStore.open(dataDir);
  const project = { id: 'example', root, dataDir, store };
  const at = new Date().toISOString();
  const run = store.createRun({ title: 'Fixture', task: 'Run the check.', workflow: 'quick-task', steps: [] });
  store.updateRun(run.id, {
    status: 'done', startedAt: at, finishedAt: at, scoreSummary: { finishedAt: at, outcome: { label: 'delivered', pass: true } },
  });
  const observed: string[] = [];
  const onChanged = vi.fn(() => {
    const entry = readRunScores(dataDir, run.id).outcome;
    if (entry) observed.push(entry.status);
  });
  const service = new ScoringService(vi.fn(), async () => ({ error: 'The judge needs configuration.' }), undefined, undefined, onChanged);
  try {
    expect(await service.rescore(project, run, 'outcome')).toEqual({ queued: ['outcome'] });
    await vi.waitFor(() => expect(readRunScores(dataDir, run.id).outcome).toMatchObject({ status: 'error' }));
    expect(observed).toEqual(['pending', 'error']);
    expect(onChanged.mock.calls).toEqual(Array.from({ length: 2 }, () => [{ projectId: project.id, runId: run.id }]));
    expect(store.getRun(run.id)?.scoreSummary?.outcome).toBeUndefined();
  } finally {
    service.dispose();
    store.flush();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});

it('redacts a preserved brief, archived credentials and the judge output before scoring or publishing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-score-redaction-'));
  const dataDir = join(root, '.ai/cezar');
  const hostValue = 'fixture-host-credential';
  const runValue = 'fixture-run-credential';
  const vaultValue = 'vault-fixture';
  vi.stubEnv('CEZ_HOME', join(root, 'workspace'));
  vi.stubEnv('CEZ_DRY_RUN', '0');
  vi.stubEnv('CEZ_SCORING', '1');
  vi.stubEnv('CEZ_REDACT_SECRETS', '0'); // Scoring crosses the runner boundary.
  vi.stubEnv('FIXTURE_API_KEY', hostValue);
  const store = RunStore.open(dataDir);
  const project = { id: 'example', root, dataDir, store };
  const vault = new SecretStore(process.env, { keychain: async () => null });
  const onScore = vi.fn();
  const call = vi.fn<JudgeCall>().mockResolvedValue({ text: JSON.stringify({
    label: 'delivered', reasoning: `Passed without exposing ${vaultValue} or ${runValue}.`, evidence: ['Observed result.'],
  }) });
  const service = new ScoringService(onScore, async () => ({ runner: 'codex', call }));
  const off = service.watch(project);
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
      factory: { scoring: { sampling: { procedure: 0, efficiency: 0, scope: 0 } } },
    }));
    await vault.set({ kind: 'project', projectId: project.id, root }, 'FIXTURE_SECRET', vaultValue, ['checks']);
    const rawBrief = `Verify using ${hostValue}, ${runValue} or ${vaultValue}.`;
    const run = store.createRun({ title: 'Fixture', task: rawBrief, workflow: 'quick-task', steps: [] });
    const at = new Date().toISOString();
    store.registerRunSecrets(run.id, [runValue]);
    store.updateRun(run.id, { status: 'running', startedAt: at });
    store.appendEvent(run.id, { type: 'text', text: `Observed result. Input was ${vaultValue}` });
    store.updateRun(run.id, { status: 'review', finishedAt: at });
    store.clearRunSecrets(run.id);
    await vi.waitFor(() => expect(onScore).toHaveBeenCalledTimes(1));
    const input = call.mock.calls[0]?.[0].userPrompt ?? '';
    const output = JSON.stringify(readRunScores(dataDir, run.id));
    expect(input).toContain('Verify using [REDACTED], [REDACTED] or [REDACTED].');
    expect(output).toContain('Passed without exposing [REDACTED] or [REDACTED].');
    for (const value of [hostValue, runValue, vaultValue]) {
      expect(input.includes(value) || output.includes(value) || JSON.stringify(onScore.mock.calls[0]?.[0]).includes(value)).toBe(false);
    }
    expect(store.getRun(run.id)?.task).toBe(rawBrief);
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
