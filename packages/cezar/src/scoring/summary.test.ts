import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scoresQuerySchema, type RecordedScore } from '@open-mercato/cezar-contract';
import { expect, it, vi } from 'vitest';
import { projectCauseQueuePath, recordCauses, routeCauses } from '../factory/causes.ts';
import { RunStore } from '../runs/store.ts';
import { writeRunScore } from './store.ts';
import { aggregateScores } from './summary.ts';

it('returns recent rubric totals and the project queue for a relative lookback', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'cez-score-summary-'));
  const store = RunStore.open(dataDir);
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-01-09T00:00:00Z'));
  try {
    const older = store.createRun({ title: 'Old', task: 'old', workflow: 'example', steps: [] });
    const newer = store.createRun({ title: 'New', task: 'new', workflow: 'example', steps: [] });
    const first = '2026-01-01T00:00:00.000Z';
    const second = '2026-01-08T00:00:00.000Z';
    store.updateRun(older.id, { status: 'done', finishedAt: first });
    store.updateRun(newer.id, { status: 'done', finishedAt: second });
    writeRunScore(dataDir, older.id, 'outcome', { status: 'error', finishedAt: first, reason: 'Test error' });
    const score: RecordedScore = {
      scorer: 'outcome', label: 'missed', score: 0, pass: false, reasoning: 'A step was omitted.',
      evidence: ['missing step'], causes: [{ category: 'repository', target: 'docs', evidence: 'missing step', fix: 'Add step.' }],
      judge: { runner: 'codex', transcriptChars: 120, shortened: false }, at: second,
    };
    writeRunScore(dataDir, newer.id, 'outcome', { status: 'scored', finishedAt: second, score });
    const origin = { projectId: 'example', runId: newer.id, harness: false };
    const causes = routeCauses(score, origin);
    recordCauses(projectCauseQueuePath(dataDir), origin, 'outcome', causes.project);

    expect(aggregateScores(dataDir, store.listRuns(), scoresQuerySchema.parse({ since: '7d' }))).toEqual({
      groups: [{ key: 'outcome', passed: 0, failed: 1, pending: 0, errors: 0 }],
      queue: { counts: { open: 1 }, openCauses: causes.project },
    });
  } finally {
    vi.restoreAllMocks();
    store.flush();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
