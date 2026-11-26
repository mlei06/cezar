import { join } from 'node:path';
import type { ImprovementDecisions, ImprovementRecord } from '@open-mercato/cezar-contract';
import { harnessCauseQueuePath, projectCauseQueuePath } from '../factory/causes.ts';
import { checkFactory } from '../factory/check.ts';
import { loadConfig } from '../config.ts';
import { artifactsDir, type RunRecord, type RunStore } from '../runs/store.ts';
import { loadWorkspaceConfig } from '../workspace/config.ts';
import {
  closeImprovement, failImprovement, finishImprovement, harnessImprovementRecordsPath, mergeImprovement,
  projectImprovementRecordsPath, readImprovementDecisions, readImprovementRecords, type ImprovementPaths,
} from './bookkeeping.ts';
import { committedImprovementPaths, improvementPathScope, IMPROVEMENT_CHECK, IMPROVEMENT_DECISIONS } from './workflow.ts';
import { resolveImprovementSettings } from './settings.ts';

export function improvementPaths(dataDir: string, harness: boolean): ImprovementPaths {
  const harnessQueue = harnessCauseQueuePath();
  return harness ? { queue: harnessQueue, records: harnessImprovementRecordsPath() }
    : { queue: projectCauseQueuePath(dataDir), records: projectImprovementRecordsPath(dataDir), harnessQueue };
}

function findBatch(dataDir: string, id: string): { record: ImprovementRecord; paths: ImprovementPaths } | undefined {
  for (const harness of [false, true]) {
    const paths = improvementPaths(dataDir, harness);
    const record = readImprovementRecords(paths.records).find((entry) => entry.id === id);
    if (record) return { record, paths };
  }
  return undefined;
}

export function runImprovementDecisions(dataDir: string, run: RunRecord):
  { decisions: ImprovementDecisions; harness: boolean; paths: ImprovementPaths; id: string } | { error: string } {
  const batch = run.improvementId && findBatch(dataDir, run.improvementId);
  if (!batch || batch.record.runId !== run.id) return { error: 'The improvement has no claimed batch.' };
  const result = readImprovementDecisions(join(artifactsDir(dataDir, run.id), IMPROVEMENT_DECISIONS));
  if ('error' in result) return result;
  const remaining = new Set(batch.record.causeIds);
  const clusterIds = new Set<string>();
  for (const cluster of result.decisions.clusters) {
    if (clusterIds.has(cluster.id)) return { error: 'Give each cluster a distinct id.' };
    clusterIds.add(cluster.id);
    for (const id of cluster.causes) {
      if (!remaining.delete(id)) return { error: 'Each cause in the batch must appear exactly once.' };
    }
  }
  return remaining.size ? { error: 'The decisions file must cover the entire batch.' }
    : { ...result, harness: batch.record.queue === 'harness', paths: batch.paths, id: batch.record.id };
}

export async function checkImprovementStep(dataDir: string, root: string, cwd: string, run: RunRecord, step: string):
  Promise<{ ok: boolean; output: string } | undefined> {
  const batch = run.improvementId && findBatch(dataDir, run.improvementId);
  if (!batch || batch.record.runId !== run.id || !run.startCommit || cwd === root) {
    return { ok: false, output: 'The improvement needs its claimed batch and separate worktree.' };
  }
  const files = await committedImprovementPaths(cwd, run.startCommit);
  if (step !== IMPROVEMENT_CHECK) {
    return files.some((path) => improvementPathScope(path) === 'code') ? undefined
      : { ok: true, output: 'No code changed. Project code validation skipped.' };
  }
  const [project, workspace, issues] = await Promise.all([loadConfig(root), loadWorkspaceConfig(), checkFactory(cwd)]);
  const scope = resolveImprovementSettings({
    harness: batch.record.queue === 'harness', project: project.factory?.improvement, workspace: workspace.factory?.improvement,
  }).scope;
  const outside = files.filter((path) => !scope.includes(improvementPathScope(path)));
  if (outside.length) return { ok: false, output: 'Changes outside the improvement scope: ' + outside.join(', ') };
  const result = runImprovementDecisions(dataDir, run);
  if ('error' in result) return { ok: false, output: result.error };
  if (files.length && !result.decisions.clusters.some(({ decision }) => decision === 'fixed')) {
    return { ok: false, output: 'A patch needs at least one fixed cluster.' };
  }
  return issues.length ? { ok: false, output: issues.map(({ path, message }) => path + ': ' + message).join('\n') }
    : { ok: true, output: 'Factory check and improvement decisions passed.' };
}

/** A factory PR can be public. The agent's raw batch and transcript stay in the cockpit. */
export function improvementPrSummary(decisions: ImprovementDecisions): string {
  const counts = ['fixed', 'dismissed', 'escalated', 'deferred'].map((kind) =>
    kind + ': ' + decisions.clusters.filter(({ decision }) => decision === kind).length);
  return '## Regressions addressed\n\nReduce recurring task failures.\n\n' +
    '- Cluster decisions: ' + counts.join(', ') + '.\n' +
    '- Evidence, expected effects and reasons are recorded with the improvement in the cockpit.\n' +
    '- Factory and applicable project checks passed.';
}

function settleRun(dataDir: string, run: RunRecord): void {
  if (!run.improvementId || !run.finishedAt || !['done', 'review', 'failed', 'cancelled'].includes(run.status)) return;
  const batch = findBatch(dataDir, run.improvementId);
  if (!batch || batch.record.runId !== run.id || batch.record.state !== 'running') return;
  const now = new Date(run.finishedAt);
  const pr = run.prRefs?.find(({ origin }) => origin === 'created');
  if (pr) {
    const result = batch.record.clusters ? { decisions: { clusters: batch.record.clusters } } : runImprovementDecisions(dataDir, run);
    // An existing PR still has to settle when earlier decisions are unavailable.
    finishImprovement(batch.paths, batch.record.id, {
      decisions: 'decisions' in result ? result.decisions : { clusters: [] },
      now, pr: { number: pr.number, url: pr.url },
    });
    return;
  }
  const result = runImprovementDecisions(dataDir, run);
  if ('error' in result || run.status === 'failed' || run.status === 'cancelled'
    || result.decisions.clusters.some(({ decision }) => decision === 'fixed')) {
    failImprovement(batch.paths, batch.record.id, now);
    return;
  }
  finishImprovement(batch.paths, batch.record.id, { decisions: result.decisions, now });
}

export function watchImprovementRuns(dataDir: string, store: RunStore, projectId: string): () => void {
  const changed = (run: RunRecord) => {
    try { settleRun(dataDir, run); }
    catch { console.warn('[cezar] improvement settlement deferred'); }
  };
  const deleted = (id: string) => {
    try {
      const batch = findBatch(dataDir, id);
      if (batch?.record.runId === id && batch.record.state === 'running') failImprovement(batch.paths, batch.record.id, new Date());
    } catch { console.warn('[cezar] improvement deletion settlement deferred'); }
  };
  store.on('run', changed);
  store.on('deleted', deleted);
  for (const run of store.listRuns()) changed(run);
  for (const harness of [false, true]) {
    const paths = improvementPaths(dataDir, harness);
    try {
      for (const record of readImprovementRecords(paths.records)) {
        if (record.projectId !== projectId || record.state !== 'running') continue;
        if (!record.runId || !store.getRun(record.runId)) failImprovement(paths, record.id, new Date());
      }
    } catch { console.warn('[cezar] improvement recovery deferred'); }
  }
  return () => { store.off('run', changed); store.off('deleted', deleted); };
}

export function hasOpenImprovementPr(dataDir: string, projectId: string, number: number): boolean {
  return [false, true].some((harness) => readImprovementRecords(improvementPaths(dataDir, harness).records).some((entry) =>
    entry.projectId === projectId && entry.state === 'pr-open' && entry.pr?.number === number));
}

export function settleImprovementPr(dataDir: string, url: string, update: { at: Date; mergedCommit?: string }): void {
  for (const harness of [false, true]) {
    const paths = improvementPaths(dataDir, harness);
    const record = readImprovementRecords(paths.records).find((entry) => entry.pr?.url === url && entry.state === 'pr-open');
    if (!record) continue;
    if (update.mergedCommit) mergeImprovement(paths, record.id, { at: update.at, commit: update.mergedCommit });
    else closeImprovement(paths, record.id, update.at);
    return;
  }
}
