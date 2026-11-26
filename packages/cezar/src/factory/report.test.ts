import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RecordedScore } from '@open-mercato/cezar-contract';
import { expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { writeRunScore } from '../scoring/store.ts';
import { factoryReportsDir, writeFactoryReport } from './report.ts';

it('reports stored scores, counts verified unique merges and escapes project text', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cez-factory-report-'));
  const store = RunStore.open(dataDir);
  try {
    const record = (number: number, day: string, pass: boolean, costUsd?: number, replayOf?: string) => {
      const run = store.createRun({ title: 'Example', task: 'Task', workflow: 'operate', steps: [] });
      const finishedAt = day + 'T12:00:00.000Z';
      store.updateRun(run.id, { status: 'done', costUsd, finishedAt, replayOf, pullRequestUrl: 'https://github.com/example/test/pull/' + number });
      const score: RecordedScore = {
        scorer: 'outcome', label: pass ? 'delivered' : 'missed', score: pass ? 1 : 0, pass,
        reasoning: 'fixture', evidence: [], causes: [], judge: { runner: 'codex', transcriptChars: 12, shortened: false }, at: finishedAt,
      };
      writeRunScore(dataDir, run.id, 'outcome', { status: 'scored', finishedAt, score });
    };
    record(3, '2026-11-15', true, 4);
    record(5, '2026-11-24', false, 2);
    record(6, '2026-11-25', true, 10);
    record(7, '2026-11-25', true, 1, 'original');
    const isMerged = vi.fn(async (number: number) => number === 5);
    const report = await writeFactoryReport({
      dataDir, project: 'fixture', name: '<script>unsafe()</script>', now: new Date('2026-11-26T00:00:00.000Z'),
      runs: store.listRuns(), harness: false, charter: '<img src=x>', isMerged, humanTouchpoints: () => 2,
    });
    expect(isMerged.mock.calls).toEqual([[5, 'https://github.com/example/test/pull/5'], [6, 'https://github.com/example/test/pull/6']]);
    expect(report.text).toContain('2 tasks finished, 1 PRs confirmed merged');
    const markup = await readFile(join(factoryReportsDir(dataDir), report.name), 'utf8');
    expect(markup).toContain('<td>outcome</td><td>100.0%</td><td>50.0%</td>');
    expect(markup).toContain('$2.000 across 1');
    expect(markup).toContain('2.0 across 1');
    expect(markup).toContain('&lt;script&gt;unsafe()&lt;/script&gt;');
    expect(markup).toContain('&lt;img src=x&gt;');
    expect(markup).not.toContain('<script>');
    const metrics = JSON.parse(await readFile(join(factoryReportsDir(dataDir), report.name + '.json'), 'utf8'));
    expect(metrics).toMatchObject({ merged: 1, costSamples: 1, humanSamples: 1, meanCostUsd: 2, meanHumanTouchpoints: 2 });

  } finally {
    store.flush();
    await rm(dataDir, { recursive: true, force: true });
  }
});
