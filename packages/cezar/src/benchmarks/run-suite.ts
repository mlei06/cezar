import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  benchmarkMatrixRunSchema,
  type BenchmarkConfiguration, type BenchmarkMatrixRun, type BenchmarkSuite, type BenchmarkTask,
} from '@open-mercato/cezar-contract';
import { loadConfig } from '../config.ts';
import { modelConflictsWithRunner } from '../core/model-presets.ts';
import { isTerminalStatus } from '../dispatch/engine.ts';
import { artifactsDir } from '../runs/store.ts';
import { readRunScores } from '../scoring/store.ts';
import { runHarnessVersion } from '../self-update/run-version.ts';
import type { ProjectContext } from '../server/project-context.ts';
import { prepareText } from '../webhooks/storage.ts';
import { atomicWriteJsonSync } from '../workspace/config.ts';
import { assertLifecyclePath, withLifecycleFileLock } from '../worktree-lifecycle/store.ts';
import { hasReplayCommit } from '../git-worktree.ts';
import { loadWorkflows } from '../workflows/load.ts';
import { agentModelsLocked } from '../core/agent-model-policy.ts';
import { replayMode, resolveTaskModelAliases, type StartRunInput } from '../workflows/run.ts';
import type { WorkflowDef } from '../workflows/types.ts';

type BenchmarkProject = Pick<ProjectContext, 'root' | 'dataDir' | 'manager' | 'store'>;
type PlannedRun = { workflow: WorkflowDef; input: StartRunInput; group: { groupId: string; variant: string } };
const MAX_REPLAYS = 40;
const CATALOG_LIMIT = 25;
const pathFor = (dataDir: string, suite: string) => join(dataDir, 'factory', 'benchmarks', suite);

export function readBenchmarkBatches(dataDir: string, suite: string): BenchmarkMatrixRun[] {
  const dir = pathFor(dataDir, suite);
  let entries: string[];
  try { entries = readdirSync(dir); }
  catch { return []; }
  return entries.filter((file) => /^[a-f0-9-]{36}\.json$/.test(file)).flatMap((file) => {
    try { return [benchmarkMatrixRunSchema.parse(JSON.parse(readFileSync(join(dir, file), 'utf8')))]; }
    catch { return []; }
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, CATALOG_LIMIT);
}

function withTaskAgentSelection<T extends { runner?: string; model?: string; reasoningEffort?: string }>(entry: T): T {
  const { runner: _runner, model: _model, reasoningEffort: _effort, ...rest } = entry;
  return rest as T;
}

async function replayTarget(project: BenchmarkProject, task: BenchmarkTask, workflow: WorkflowDef,
  choice: BenchmarkConfiguration, meta: Awaited<ReturnType<typeof runHarnessVersion>>,
): Promise<{ input: StartRunInput; workflow: WorkflowDef } | { reason: string }> {
  const local = await loadConfig(project.root);
  const agentSteps = workflow.steps.filter((step) => !step.command);
  if (agentSteps.some((step) => step.runner && step.runner !== 'codex')) return { reason: 'A workflow agent is outside the current replay sandbox.' };
  const saved = task.sourceRun ? project.store.getRun(task.sourceRun) : undefined;
  const implicit = agentSteps[0]?.model;
  if (!choice.model && agentSteps.some((step) => step.model !== implicit)) return { reason: 'Name a model for this configuration to compare a mixed-model workflow.' };
  if ((choice.model || choice.effort) && agentModelsLocked(project.root)) return { reason: 'The project locks its configured agent models.' };
  const requestedModel = choice.model ?? implicit ?? saved?.model;
  const candidate = {
    ...workflow, steps: workflow.steps.map((step) => step.command ? step : withTaskAgentSelection(step)),
    ...(workflow.graph ? { graph: { ...workflow.graph, nodes: workflow.graph.nodes.map((node) => node.type === 'agent' ? withTaskAgentSelection(node) : node) } } : {}),
  };
  const mode = replayMode(candidate);
  if (!mode) return { reason: 'This workflow cannot run in the current replay sandbox.' };
  const current = choice.runner ?? agentSteps[0]?.runner ?? saved?.runner ?? local.defaultRunner;
  const { route } = mode === 'agent' ? await resolveTaskModelAliases(candidate, project.root, {
    runner: current, model: requestedModel, agentProfile: saved?.runner === current ? saved.agentProfile : undefined,
  }, () => undefined, local) : {};
  const runner = route?.runner ?? current;
  const model = route?.model ?? requestedModel;
  if (mode === 'agent' && runner !== 'codex') return { reason: 'Agent replay currently requires the Codex sandbox for this route.' };
  if (mode === 'agent' && model && modelConflictsWithRunner(model, 'codex')) return { reason: 'The model does not belong to the replay runner.' };
  if (mode === 'checks' && (choice.runner || choice.model || choice.effort)) return { reason: 'This workflow only has checks and has no model to compare.' };
  const prompt = task.prompt + '\n\nSuccess criteria:\n' + task.successCriteria;
  return {
    workflow: candidate,
    input: {
      task: prompt, worktree: true, generateFollowups: false, modelRoutePinned: true,
      ...(mode === 'agent' ? {
        runner: 'codex', model, agentProfile: route?.agentProfile ?? (saved?.runner === 'codex' ? saved.agentProfile : undefined),
        reasoningEffort: choice.effort ?? route?.reasoningEffort ?? agentSteps[0]?.reasoningEffort ?? saved?.reasoningEffort,
        readOnly: true, enforceReadOnly: true, secrets: [],
      } : {}),
      replay: { sourceId: task.sourceRun ?? 'benchmark-fixture', startCommit: task.startCommit, change: 'benchmark ' + choice.name, harness: meta },
    },
  };
}

export async function runBenchmarkSuite(project: BenchmarkProject, name: string, suite: BenchmarkSuite,
  tasks: ReadonlyMap<string, BenchmarkTask>, config?: string): Promise<{ batch: BenchmarkMatrixRun } | { reason: string }> {
  const choices = config ? suite.configurations.filter(({ name }) => name === config) : suite.configurations;
  if (!choices.length) return { reason: 'The suite has no configuration with that name.' };
  if (tasks.size * choices.length * suite.times > MAX_REPLAYS) {
    return { reason: 'A benchmark batch can queue up to 40 replays. Run one configuration or use a smaller suite.' };
  }
  if (process.platform !== 'linux') return { reason: 'Benchmarks need the Linux replay sandbox.' };
  const [meta, catalog] = await Promise.all([runHarnessVersion(), loadWorkflows(project.root)]);
  if (!meta.commit) return { reason: 'The running harness needs an exact release commit.' };
  const dir = pathFor(project.dataDir, name);
  await assertLifecyclePath(dir, project.root);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return withLifecycleFileLock(join(dir, 'run.lock'), async () => {
    const active = readBenchmarkBatches(project.dataDir, name).some(({ runs }) => runs.some((entry) => {
      if (entry.state !== 'started') return false;
      const run = project.store.getRun(entry.runId);
      return run && !isTerminalStatus(run.status);
    }));
    if (active) return { reason: 'This suite already has a batch running.' };
    const batch: BenchmarkMatrixRun = { id: randomUUID(), suite: name, createdAt: new Date().toISOString(), scorers: suite.scorers, runs: [] };
    const plans: PlannedRun[] = [];
    for (const [taskId, task] of tasks) {
      const workflow = catalog.workflows.find((entry) => entry.name === task.workflow);
      const available = workflow && await hasReplayCommit(project.root, task.startCommit);
      const groupId = randomUUID();
      let variant = 0;
      for (const choice of choices) {
        const target = available && workflow ? await replayTarget(project, task, workflow, choice, meta)
          : { reason: 'The exact project commit or workflow is unavailable.' };
        if ('reason' in target) {
          batch.runs.push({ state: 'unavailable', task: taskId, config: choice.name, reason: target.reason });
          continue;
        }
        for (let repeat = 0; repeat < suite.times; repeat++) {
          const runId = randomUUID();
          batch.runs.push({ state: 'started', task: taskId, config: choice.name, runId });
          plans.push({ ...target, input: { ...target.input, benchmarkRunId: runId }, group: { groupId, variant: String(++variant) } });
        }
      }
    }
    atomicWriteJsonSync(join(dir, batch.id + '.json'), batch);
    for (const { workflow, input, group } of plans) project.manager.startRun(workflow, input, group);
    project.store.flush();
    return { batch };
  });
}

export async function benchmarkResults(project: BenchmarkProject, batch: BenchmarkMatrixRun) {
  const rows = [...new Set(batch.runs.map(({ config }) => config))].map((name) => {
    const entries = batch.runs.filter(({ config }) => config === name);
    let started = 0, unsettled = 0, unavailable = 0, passed = 0, failed = 0, pending = 0, missing = 0;
    const costs: number[] = [];
    const times: number[] = [];
    for (const entry of entries) {
      const run = entry.state === 'started' ? project.store.getRun(entry.runId) : undefined;
      if (!run || run.replayChange !== 'benchmark ' + name) { unavailable++; continue; }
      started++;
      if (!run.finishedAt || !isTerminalStatus(run.status)) { unsettled++; continue; }
      if (run.costUsd !== undefined) costs.push(run.costUsd);
      if (run.startedAt) times.push(Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.startedAt)));
      let scoring;
      try { scoring = readRunScores(project.dataDir, run.id); }
      catch { missing += batch.scorers.length; continue; }
      for (const scorer of batch.scorers) {
        const score = scoring[scorer];
        if (!score || score.finishedAt !== run.finishedAt) {
          if (Date.now() - Date.parse(run.finishedAt) < 15_000) pending++;
          else missing++;
        } else if (score.status === 'error') missing++;
        else if (score.status === 'pending') pending++;
        else if (score.score.pass) passed++;
        else failed++;
      }
    }
    const average = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
    return { name, started, unsettled, unavailable, passed, failed, pending, missing,
      ...(costs.length ? { meanCostUsd: average(costs) } : {}), ...(times.length ? { meanWallMs: average(times) } : {}) };
  });
  const artifactRunId = batch.runs.find((entry) => entry.state === 'started' &&
    project.store.getRun(entry.runId)?.replayChange === 'benchmark ' + entry.config);
  if (!artifactRunId || artifactRunId.state !== 'started' || rows.some(({ unsettled }) => unsettled)) return { batch, rows };
  const name = 'benchmark-' + batch.suite + '.json';
  const dir = artifactsDir(project.dataDir, artifactRunId.runId);
  await assertLifecyclePath(dir, project.root);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const report = JSON.stringify({ batch, rows }, null, 2) + '\n';
  const path = join(dir, name);
  if (!existsSync(path) || readFileSync(path, 'utf8') !== report) {
    const prepared = await prepareText(dir, name, report);
    try { prepared.publish(); await prepared.finish(); }
    finally { await prepared.discard(); }
  }
  return { batch, rows, artifact: { runId: artifactRunId.runId, name } };
}
