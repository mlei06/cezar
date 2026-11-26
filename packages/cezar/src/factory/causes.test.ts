import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { RecordedScore, ScoreCause } from '@open-mercato/cezar-contract';
import { readCauseQueue, recordCauses, routeCauses } from './causes.ts';

const at = '2026-01-01T00:00:00.000Z';
const score: RecordedScore = {
  scorer: 'outcome', label: 'missed', score: 0, pass: false, reasoning: 'Observed facts.',
  evidence: [], causes: [], judge: { runner: 'codex', transcriptChars: 0, shortened: false }, at,
};
const origin = { projectId: 'fixture', runId: 'task', harness: false };
const cause = (target: ScoreCause['target']): ScoreCause =>
  ({ category: 'repository', target, evidence: 'Observed fact.', fix: 'Address the fact.' });

it('routes each cause independently and isolates benchmark and infrastructure findings', () => {
  const batch = { ...score, causes: [cause('workflow'), cause('harness'), cause('infra')] };
  expect(routeCauses(batch, origin)).toMatchObject({
    project: [{ cause: { target: 'workflow' } }], harness: [{ cause: { target: 'harness' } }], infra: [{ cause: { target: 'infra' } }],
  });
  expect(routeCauses(batch, { ...origin, benchmark: true })).toEqual({ project: [], harness: [], infra: [] });
  expect(routeCauses(batch, { ...origin, replay: true })).toEqual({ project: [], harness: [], infra: [] });
  expect(routeCauses(batch, { ...origin, harness: true }).harness).toHaveLength(2);
  expect(routeCauses({ ...score, causes: [cause('brief')] }, { ...origin, workflowSource: 'built-in' }).harness).toHaveLength(1);
});

it('refreshes a rubric without leaving stale or duplicate open causes', () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-cause-queue-'));
  try {
    const path = join(root, 'queue.json');
    const entries = routeCauses({ ...score, causes: [cause('code')] }, origin).project;
    recordCauses(path, origin, score.scorer, entries);
    recordCauses(path, origin, score.scorer, [...entries, ...entries]);
    expect(readCauseQueue(path)).toEqual(entries);
    recordCauses(path, origin, score.scorer, []);
    expect(readCauseQueue(path)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
