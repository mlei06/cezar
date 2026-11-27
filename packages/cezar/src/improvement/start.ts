import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ImprovementRecord, RunRecord } from '@open-mercato/cezar-contract';
import { loadConfig } from '../config.ts';
import { detectHarnessProject, readCauseQueue } from '../factory/causes.ts';
import { readRunIndexFromDisk } from '../runs/run-index.ts';
import { runHarnessVersion } from '../self-update/run-version.ts';
import type { ProjectContext } from '../server/project-context.ts';
import { resolveForge } from '../server/forge/index.ts';
import { samePrUrl } from '../server/forge/pr-url.ts';
import { getRepoInfo } from '../server/git.ts';
import { loadWorkspaceConfig } from '../workspace/config.ts';
import { loadWorkflows } from '../workflows/load.ts';
import { failImprovement, readImprovementRecords, recordImprovementComparison, startImprovement } from './bookkeeping.ts';
import { compareImprovement, harnessCauseDigest, type ImprovementRunHistory } from './comparison.ts';
import { improvementPaths, settleImprovementPr } from './lifecycle.ts';
import { resolveImprovementSettings } from './settings.ts';
import { evaluateImprovementTrigger } from './trigger.ts';
import { hasImprovementSkill, IMPROVE_FACTORY, improvementBrief } from './workflow.ts';

const exec = promisify(execFile);
type ImprovementProject = Pick<ProjectContext, 'id' | 'root' | 'dataDir' | 'store' | 'manager'>;

function latestMerge(records: readonly ImprovementRecord[]): ImprovementRecord | undefined {
  return records.filter(({ state, mergedAt }) => state === 'merged' && mergedAt)
    .sort((a, b) => b.mergedAt!.localeCompare(a.mergedAt!))[0];
}

async function currentReleaseWithMerge(project: ImprovementProject, last: ImprovementRecord) {
  const version = await runHarnessVersion();
  const sha = /^(?:[a-f\d]{40}|[a-f\d]{64})$/;
  if (!version.commit || !last.mergeCommit || !sha.test(version.commit) || !sha.test(last.mergeCommit)) return undefined;
  const includesMerge = await exec('git', ['merge-base', '--is-ancestor', last.mergeCommit, version.commit], {
    cwd: project.root, timeout: 5_000, env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1' },
  }).then(() => true, () => false);
  return includesMerge ? version : undefined;
}

function collectHistory(project: ImprovementProject, roots: readonly { root: string }[], harness: boolean): ImprovementRunHistory[] {
  const own = { dataDir: project.dataDir, runs: project.store.listRuns() };
  if (!harness) return [own];
  return [own, ...roots.filter(({ root }) => root !== project.root).map(({ root }) => {
    const dataDir = join(root, '.ai/cezar');
    return { dataDir, runs: readRunIndexFromDisk(dataDir) };
  })];
}

async function refreshOpenPr(project: ImprovementProject, records: readonly ImprovementRecord[]): Promise<void> {
  const open = records.find((entry) => entry.projectId === project.id && entry.state === 'pr-open' && entry.pr?.number && entry.pr.url);
  if (!open?.pr?.number || !open.pr.url) return;
  const forge = resolveForge(await getRepoInfo(project.root));
  const result = await forge?.prMergeState?.(open.pr.number, { refresh: true });
  if (!result?.available || !samePrUrl(result.mergeState.url, open.pr.url)) return;
  const pr = result.mergeState;
  if (pr.state === 'closed') settleImprovementPr(project.dataDir, pr.url, { at: new Date(), projectId: project.id });
  if (pr.state === 'merged' && pr.mergeCommitSha) {
    settleImprovementPr(project.dataDir, pr.url, { at: new Date(pr.mergedAt ?? Date.now()), mergedCommit: pr.mergeCommitSha, projectId: project.id });
  }
}

export async function startFactoryImprovement(
  project: ImprovementProject,
  startedBy: ImprovementRecord['startedBy'],
  provenance?: Pick<NonNullable<RunRecord['automationTrigger']>, 'automationId' | 'automationRevision' | 'occurrenceAt'>,
): Promise<{ run: RunRecord } | { reason: string }> {
  const [local, workspace, catalog] = await Promise.all([
    loadConfig(project.root), loadWorkspaceConfig(), loadWorkflows(project.root),
  ]);
  const harness = detectHarnessProject(workspace.projects, workspace.factory?.harnessProject) === project.id;
  const settings = resolveImprovementSettings({ harness, workspace: workspace.factory?.improvement, project: local.factory?.improvement });
  if (!settings.enabled) return { reason: 'self-improvement is turned off' };
  const workflow = catalog.workflows.find(({ name, source }) => name === IMPROVE_FACTORY && source === 'built-in');
  if (!workflow) return { reason: 'the built-in improve-factory workflow is unavailable' };
  if (!hasImprovementSkill() && process.env.CEZ_DRY_RUN !== '1') return { reason: 'the approved improve-factory skill is unavailable' };

  const paths = improvementPaths(project.dataDir, harness);
  await refreshOpenPr(project, readImprovementRecords(paths.records));
  const priorMerge = latestMerge(readImprovementRecords(paths.records));
  const afterRelease = harness && priorMerge ? await currentReleaseWithMerge(project, priorMerge) : undefined;
  const history = priorMerge && (!harness || afterRelease) ? collectHistory(project, workspace.projects, harness) : [];
  const scoredRunsSinceMerge = history.flatMap(({ runs }) => runs).filter((run) =>
    !run.replayOf && run.scoreSummary && run.finishedAt && run.finishedAt > priorMerge!.mergedAt! &&
    (!afterRelease || (run.harnessVersion?.id === afterRelease.id && run.harnessVersion?.commit === afterRelease.commit))).length;
  const records = readImprovementRecords(paths.records);
  if (latestMerge(records)?.id !== priorMerge?.id) return { reason: 'the improvement cooldown changed during this check' };
  const now = new Date();
  if (priorMerge && history.length) {
    const comparison = compareImprovement({ record: priorMerge, history, cooldown: settings, now, afterRelease });
    if (comparison) {
      const index = records.findIndex(({ id }) => id === priorMerge.id);
      records[index] = recordImprovementComparison(paths, priorMerge.id, comparison);
    }
  }
  const result = evaluateImprovementTrigger({
    queue: readCauseQueue(paths.queue), records, settings, scoredRunsSinceMerge, now, manual: startedBy !== 'automation',
  });
  if (!result.fire) return { reason: result.reason };

  const id = randomUUID();
  startImprovement(paths, { id, projectId: project.id, runId: id, startedBy, startedAt: now.toISOString(), batch: result.batch });
  try {
    const task = improvementBrief({
      batch: result.batch, previous: records, scope: settings.scope,
      ...(harness ? { crossProjectDigest: harnessCauseDigest(workspace.projects, project.id, now) } : {}),
    });
    const run = project.manager.startRun(workflow, {
      task, improvementId: id,
      ...(provenance ? { improvementAutomation: { ...provenance, trigger: 'factory', receiptId: id } } : {}),
    });
    project.store.flush();
    return { run };
  } catch (error) {
    if (!project.store.getRun(id)) failImprovement(paths, id, new Date());
    throw error;
  }
}
