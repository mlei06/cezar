import { randomUUID } from 'node:crypto';
import type { ImprovementRecord, RunRecord } from '@open-mercato/cezar-contract';
import { loadConfig } from '../config.ts';
import { detectHarnessProject, readCauseQueue } from '../factory/causes.ts';
import type { ProjectContext } from '../server/project-context.ts';
import { loadWorkspaceConfig } from '../workspace/config.ts';
import { loadWorkflows } from '../workflows/load.ts';
import { failImprovement, readImprovementRecords, startImprovement } from './bookkeeping.ts';
import { improvementPaths } from './lifecycle.ts';
import { resolveImprovementSettings } from './settings.ts';
import { evaluateImprovementTrigger } from './trigger.ts';
import { hasImprovementSkill, IMPROVE_FACTORY, improvementBrief } from './workflow.ts';

export async function startFactoryImprovement(
  project: Pick<ProjectContext, 'id' | 'root' | 'dataDir' | 'store' | 'manager'>,
  startedBy: ImprovementRecord['startedBy'],
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
  const records = readImprovementRecords(paths.records);
  const recent = records.filter(({ state, mergedAt }) => state === 'merged' && mergedAt)
    .reduce((latest, entry) => Math.max(latest, Date.parse(entry.mergedAt!)), 0);
  const scoredRunsSinceMerge = harness ? 0 : project.store.listRuns().filter((run) =>
    !run.replayOf && run.scoreSummary && run.finishedAt && Date.parse(run.finishedAt) > recent).length;
  const now = new Date();
  const result = evaluateImprovementTrigger({
    queue: readCauseQueue(paths.queue), records, settings, scoredRunsSinceMerge, now, manual: startedBy !== 'automation',
  });
  if (!result.fire) return { reason: result.reason };

  const id = randomUUID();
  startImprovement(paths, { id, projectId: project.id, runId: id, startedBy, startedAt: now.toISOString(), batch: result.batch });
  try {
    const task = improvementBrief({ batch: result.batch, previous: records, scope: settings.scope });
    const run = project.manager.startRun(workflow, { task, improvementId: id });
    project.store.flush();
    return { run };
  } catch (error) {
    if (!project.store.getRun(id)) failImprovement(paths, id, new Date());
    throw error;
  }
}
