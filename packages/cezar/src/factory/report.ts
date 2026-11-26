import { randomUUID } from 'node:crypto';
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { factoryWeeklyMetricsSchema, type ScoreGroup } from '@open-mercato/cezar-contract';
import { harnessImprovementRecordsPath, projectImprovementRecordsPath, readImprovementRecords } from '../improvement/bookkeeping.ts';
import type { RunRecord } from '../runs/store.ts';
import { aggregateScores } from '../scoring/summary.ts';
import { atomicWriteJson } from '../workspace/config.ts';
import { prNumberOfUrl } from '../server/forge/pr-url.ts';
import { mapWithConcurrency } from '../server/concurrency.ts';
import { harnessCauseQueuePath, projectCauseQueuePath, readCauseQueue } from './causes.ts';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PRS = 50;
export const FACTORY_REPORT_JOB = 'factory-weekly-report';

const html = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (match) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[match]!);
const ratio = (passed: number, failed: number) => passed + failed ? (100 * passed / (passed + failed)).toFixed(1) + '%' : 'No scores';
const cells = (values: readonly unknown[]) => '<tr>' + values.map((value) => '<td>' + html(value) + '</td>').join('') + '</tr>';
const table = (columns: string[], rows: string[]) => rows.length
  ? '<table><thead><tr>' + columns.map((column) => '<th scope="col">' + html(column) + '</th>').join('') + '</tr></thead><tbody>' + rows.join('') + '</tbody></table>'
  : '<p>No records in this period.</p>';

export function factoryReportsDir(dataDir: string): string {
  return join(dataDir, 'factory', 'reports');
}

export async function writeFactoryReport(input: {
  dataDir: string;
  project: string;
  name: string;
  now: Date;
  runs: readonly RunRecord[];
  harness: boolean;
  charter: string;
  isMerged: (number: number, url: string) => Promise<boolean | undefined>;
  humanTouchpoints: (runId: string) => number | undefined;
}): Promise<{ name: string; text: string }> {
  const { dataDir, project, name, now, harness } = input;
  const at = now.getTime();
  const current = at - WEEK_MS;
  const runs = input.runs.filter(({ finishedAt, replayOf }) => !replayOf && finishedAt && Date.parse(finishedAt) <= at);
  const recent = runs.filter(({ finishedAt }) => Date.parse(finishedAt!) >= current);
  const earlier = runs.filter(({ finishedAt }) => Date.parse(finishedAt!) >= current - WEEK_MS && Date.parse(finishedAt!) < current);
  const scoreRows = (rows: RunRecord[]) => aggregateScores(dataDir, rows, { groupBy: 'scorer' }).groups;
  const currentScores = scoreRows(recent);
  const previousScores = scoreRows(earlier);
  const names = [...new Set([...currentScores, ...previousScores].map(({ key }) => key))].sort();
  const rate = (scores: ScoreGroup[], key: string) => {
    const row = scores.find((entry) => entry.key === key);
    return row ? ratio(row.passed, row.failed) : 'No scores';
  };

  // Attribute only the work Cezar knows opened a PR, using one run per PR and checking the forge.
  const opened = new Map<number, { run: RunRecord; url: string }>();
  for (const run of recent.sort((a, b) => a.finishedAt!.localeCompare(b.finishedAt!))) {
    const created = run.prRefs?.find(({ origin }) => origin === 'created');
    const url = created?.url ?? run.pullRequestUrl;
    const number = created?.number ?? prNumberOfUrl(url);
    if (number && url) opened.set(number, { run, url });
  }
  const sampled = [...opened].slice(-MAX_PRS);
  const results = await mapWithConcurrency(sampled, 4, async ([number, { run, url }]) => ({
    run, merged: await input.isMerged(number, url).catch(() => undefined),
  }));
  const merged = results.filter((entry) => entry.merged === true);
  const costs = merged.flatMap(({ run }) => run.costUsd === undefined || run.costUsd < 0 ? [] : [run.costUsd]);
  const touches = merged.flatMap(({ run }) => {
    const count = input.humanTouchpoints(run.id);
    return count === undefined ? [] : [count];
  });
  const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const mean = (values: number[], format: (value: number) => string) => values.length
    ? format(average(values)) + ' across ' + values.length
    : 'No measurements';
  const paths = harness ? { queue: harnessCauseQueuePath(), records: harnessImprovementRecordsPath() }
    : { queue: projectCauseQueuePath(dataDir), records: projectImprovementRecordsPath(dataDir) };
  const causes = readCauseQueue(paths.queue);
  const open = causes.filter(({ state }) => state === 'open');
  const improvements = readImprovementRecords(paths.records).filter((record) => record.projectId === project &&
    (record.state === 'pr-open' || (record.state === 'merged' && Date.parse(record.mergedAt ?? '') >= current)));

  const artifactName = 'factory-week-' + now.toISOString().slice(0, 10) + '.html';
  const markup = '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Weekly factory report</title><style>body{font:1rem system-ui;max-width:70rem;margin:2rem auto;padding:0 1rem}th,td{text-align:left;padding:.5rem;border-bottom:1px solid #8885}table{width:100%;border-collapse:collapse}pre{white-space:pre-wrap}</style>' +
    '<h1>Weekly factory report for ' + html(name) + '</h1><p>Week ending ' + html(now.toISOString().slice(0, 10)) + ' (UTC)</p>' +
    '<h2>Score trends</h2>' + table(['Scorer', 'Previous week', 'This week'], names.map((scorer) => cells([scorer, rate(previousScores, scorer), rate(currentScores, scorer)]))) +
    '<h2>Confirmed merges from this week’s tasks</h2><p>' + merged.length + ' merged across ' + sampled.length + ' checked. ' +
    (opened.size - sampled.length + results.filter(({ merged }) => merged === undefined).length) + ' could not be confirmed.</p>' +
    '<ul><li>Mean recorded task cost per merged PR: ' + mean(costs, (cost) => '$' + cost.toFixed(3)) +
    '</li><li>Mean recorded human follow-ups per merged PR: ' + mean(touches, (count) => count.toFixed(1)) + '</li></ul>' +
    '<h2>Cause queue</h2><p>' + open.length + ' open, ' + causes.filter(({ state }) => state === 'processing').length + ' in flight.</p>' +
    table(['Scorer', 'Category', 'Target', 'Suggested fix'], open.slice(0, 10).map(({ scorer, cause }) => cells([scorer, cause.category, cause.target, cause.fix]))) +
    '<h2>Improvements</h2>' + table(['PR', 'State', 'Before and after'], improvements.map((record) => cells([
      record.pr?.number ? '#' + record.pr.number : 'Unavailable', record.state,
      record.comparison ? record.comparison.after.map((row) => {
        const before = record.comparison?.before.find(({ scorer }) => scorer === row.scorer);
        return row.scorer + ' ' + (before ? ratio(before.passed, before.failed) : 'No scores') + ' → ' + ratio(row.passed, row.failed);
      }).join(', ') : 'Awaiting measurements',
    ]))) + (input.charter ? '<h2>Project progress and backlog</h2><pre>' + html(input.charter) + '</pre>' : '') + '</html>';

  const factory = join(dataDir, 'factory');
  await mkdir(factory, { recursive: true, mode: 0o700 });
  if (!(await lstat(factory)).isDirectory()) throw new Error('The factory directory is unavailable.');
  const dir = factoryReportsDir(dataDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (!(await lstat(dir)).isDirectory()) throw new Error('The factory report directory is unavailable.');
  const temp = join(dir, '.' + randomUUID() + '.tmp');
  try {
    await writeFile(temp, markup, { flag: 'wx', mode: 0o600 });
    await rename(temp, join(dir, artifactName));
  } finally {
    await rm(temp, { force: true });
  }
  await atomicWriteJson(join(dir, artifactName + '.json'), factoryWeeklyMetricsSchema.parse({
    at: now.toISOString(), merged: merged.length, costSamples: costs.length, humanSamples: touches.length,
    ...(costs.length ? { meanCostUsd: average(costs) } : {}),
    ...(touches.length ? { meanHumanTouchpoints: average(touches) } : {}),
  }));
  return {
    name: artifactName,
    text: recent.length + ' tasks finished, ' + merged.length + ' PRs confirmed merged, and ' + open.length + ' causes are open.',
  };
}
