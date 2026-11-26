import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { ImprovementRecord } from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import { writeRunScore } from '../scoring/store.ts';
import { compareImprovement } from './comparison.ts';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cez-improvement-comparison-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('compares equal sample sizes and attributes harness impact to the verified release', () => {
  const store = RunStore.open(root);
  const mergedAt = '2026-02-10T12:00:00.000Z';
  const version = { id: 'candidate', commit: 'a'.repeat(40) };
  const baseline = { id: 'previous', commit: 'b'.repeat(40) };
  function scored(at: string, pass: boolean, harnessVersion: typeof version, costUsd?: number, replayOf?: string) {
    const run = store.createRun({ title: 'Example', task: 'Example', workflow: 'plan', steps: [] });
    store.updateRun(run.id, { status: 'done', finishedAt: at, harnessVersion, costUsd, replayOf });
    writeRunScore(root, run.id, 'outcome', {
      status: 'scored', finishedAt: at, score: {
        at, scorer: 'outcome', label: pass ? 'delivered' : 'missed', score: pass ? 1 : 0, pass,
        reasoning: 'Synthetic fixture.', evidence: [], causes: [],
        judge: { runner: 'codex', transcriptChars: 1, shortened: false },
      },
    });
  }
  scored('2026-02-10T09:00:00.000Z', true, baseline, 0);
  scored('2026-02-10T10:00:00.000Z', true, baseline);
  scored('2026-02-10T13:00:00.000Z', true, baseline, 0.25);
  scored('2026-02-10T14:00:00.000Z', true, version, 0.5, 'original');
  scored('2026-02-10T15:00:00.000Z', false, version, 1);
  const input = {
    now: new Date('2026-02-10T18:00:00.000Z'), afterRelease: version,
    record: {
      id: 'improvement', projectId: 'test-project', queue: 'harness', state: 'merged', mergedAt,
      startedAt: mergedAt, startedBy: 'owner', causeIds: [],
    } satisfies ImprovementRecord,
    history: [{ dataDir: root, runs: store.listRuns() }],
  };
  expect(compareImprovement({ ...input, cooldown: { cooldownRuns: 2 } })).toBeUndefined();
  expect(compareImprovement({ ...input, cooldown: { cooldownRuns: 1 } })).toEqual({
    measuredAt: input.now.toISOString(), harnessVersion: version, beforeRuns: 1, afterRuns: 1, regressed: true,
    before: [{ scorer: 'outcome', passed: 1, failed: 0, costSamples: 0 }],
    after: [{ scorer: 'outcome', passed: 0, failed: 1, costSamples: 1, meanCostUsd: 1 }],
  });
});
