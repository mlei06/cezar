import { readdir, readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { loadConfig, type CezConfig } from '../config.ts';
import { runnerSupportsReasoningEffort, type RunnerId } from '../core/agent-runner.ts';
import { loadWorkspaceConfig } from '../workspace/config.ts';
import { graphIssues, graphToSteps, workflowGraphFileSchema } from './graph.ts';
import { ASSESS_IMPACT_WORKFLOW, BUILT_IN_GRAPH_WORKFLOWS, HIGH_REASONING_MODEL_ALIAS, implementWorkflow, LOW_REASONING_MODEL_ALIAS } from './templates.ts';
import { chooseTaskAgent, type AccountOption } from '../managers/task-agent-choice.ts';
import {
  QUICK_TASK_WORKFLOW,
  normalizeWorkflowDoc,
  stepsIssue,
  workflowDefSchema,
  workflowFileSchema,
  type WorkflowDef,
} from './types.ts';

export const WORKFLOWS_DIR = '.ai/cezar/workflows';

export interface WorkflowLoadIssue {
  path: string;
  message: string;
}

const validationConfigPath = '.ai/agentic.config.json';
const validationConfig = z.object({
  validation: z.object({ commands: z.array(z.string().refine((command) => command.trim().length > 0)).optional() }).optional(),
});
const testScript = z.object({ scripts: z.object({ test: z.string().trim().min(1) }) });

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

async function validationCommands(repoRoot: string): Promise<string[]> {
  const raw = await readFile(join(repoRoot, validationConfigPath), 'utf8').catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return undefined;
    throw new Error('unable to read validation configuration', { cause: err });
  });
  if (raw !== undefined) {
    let doc: unknown;
    try {
      doc = JSON.parse(raw);
    } catch {
      throw new Error('validation configuration is not valid JSON');
    }
    const config = validationConfig.safeParse(doc);
    if (!config.success) {
      throw new Error('validation.commands must be an array of non-blank command strings');
    }
    if (config.data.validation?.commands !== undefined) return config.data.validation.commands;
  }
  const manifest = testScript.safeParse(await readJson(join(repoRoot, 'package.json')));
  return manifest.success ? ['npm test'] : [];
}

/**
 * Load the workflow catalog: the built-in `quick-task` plus every
 * `.ai/cezar/workflows/*.{yaml,yml}` in the repo. File workflows win name
 * collisions with built-ins. Invalid files are reported, never fatal.
 */
export async function loadWorkflows(
  repoRoot: string,
): Promise<{ workflows: WorkflowDef[]; issues: WorkflowLoadIssue[] }> {
  const dir = resolve(repoRoot, WORKFLOWS_DIR);
  const issues: WorkflowLoadIssue[] = [];
  const fromFiles: WorkflowDef[] = [];

  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    // no workflows dir — built-ins only
  }

  for (const entry of entries) {
    const ext = extname(entry).toLowerCase();
    if (ext !== '.yaml' && ext !== '.yml') continue;
    const path = join(dir, entry);
    try {
      const raw = await readFile(path, 'utf8');
      const doc: unknown = parseYaml(raw);
      // `version: 2` is a graph workflow (spec 2026-09-30-workflow-node-editor); anything else
      // is the v1 `steps`/`skills` format, loaded exactly as before. A hand-edited file may
      // quote the version (`version: "2"`) — treated the same as the numeric literal, or this
      // falls through to a confusing v1 "missing steps" error instead.
      const docVersion = doc && typeof doc === 'object' ? (doc as { version?: unknown }).version : undefined;
      if (doc && typeof doc === 'object' && (docVersion === 2 || docVersion === '2')) {
        const graphDoc = workflowGraphFileSchema.safeParse({ ...(doc as object), version: 2 });
        if (!graphDoc.success) {
          issues.push({ path, message: graphDoc.error.issues.map((i) => i.message).join('; ') });
          continue;
        }
        const problems = graphIssues(graphDoc.data);
        if (problems.length) {
          issues.push({ path, message: problems.join('; ') });
          continue;
        }
        const { version, name, description, budget, nodes, edges, layout } = graphDoc.data;
        void version;
        fromFiles.push({
          name,
          ...(description ? { description } : {}),
          ...(budget ? { budget } : {}),
          steps: graphToSteps(graphDoc.data),
          graph: { nodes, edges, ...(layout ? { layout } : {}) },
          source: 'file',
          path,
        });
        continue;
      }
      const parsed = workflowFileSchema.safeParse(doc);
      if (!parsed.success) {
        issues.push({ path, message: parsed.error.issues.map((i) => i.message).join('; ') });
        continue;
      }
      // `skills:` shorthand files become plain agent steps here (spec 012).
      const normalized = normalizeWorkflowDoc(parsed.data);
      // Steps referenced by onFail.retry must exist and come earlier; ids unique.
      const issue = stepsIssue(normalized.steps);
      if (issue) {
        issues.push({ path, message: issue });
        continue;
      }
      fromFiles.push({ ...normalized, source: 'file', path });
    } catch (err) {
      issues.push({ path, message: err instanceof Error ? err.message : String(err) });
    }
  }

  const fileNames = new Set(fromFiles.map((w) => w.name));
  const workflows = [
    ...fromFiles,
    ...[QUICK_TASK_WORKFLOW, ASSESS_IMPACT_WORKFLOW, ...BUILT_IN_GRAPH_WORKFLOWS]
      .filter((w) => !fileNames.has(w.name) && w.name !== 'implement'),
  ];
  if (!fileNames.has('implement')) {
    try {
      workflows.push(implementWorkflow(await validationCommands(repoRoot)));
    } catch (err) {
      issues.push({
        path: join(repoRoot, validationConfigPath),
        message: `cannot construct the implement workflow: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  workflows.sort((a, b) => a.name.localeCompare(b.name));
  return { workflows, issues };
}

type ModelAlias = typeof LOW_REASONING_MODEL_ALIAS | typeof HIGH_REASONING_MODEL_ALIAS;
type ModelRoute = { runner: RunnerId; model: string; agentProfile?: string; reasoningEffort?: 'low' | 'high' };

export function modelAlias(model: string | undefined): ModelAlias | undefined {
  return model === LOW_REASONING_MODEL_ALIAS || model === HIGH_REASONING_MODEL_ALIAS ? model : undefined;
}

const modelHealth = new Map<string, { expires: number; result: Promise<boolean> }>();

function modelReachable(endpoint: string): Promise<boolean> {
  const cached = modelHealth.get(endpoint);
  if (cached && cached.expires > Date.now()) return cached.result;
  const result = fetch(endpoint, { redirect: 'error', signal: AbortSignal.timeout(5_000) }).then(
    (response) => {
      void response.body?.cancel().catch(() => undefined);
      // The credential-free probe can receive an auth challenge from a reachable model server.
      return response.ok || response.status === 401 || response.status === 403;
    },
    () => false,
  );
  if (modelHealth.size >= 32) modelHealth.clear();
  modelHealth.set(endpoint, { expires: Date.now() + 60_000, result });
  return result;
}

/** Resolve model aliases before provider preflight or an engine launch. */
export async function resolveWorkflowModelAlias(
  workflow: WorkflowDef,
  repoRoot: string,
  projectConfig?: CezConfig,
  options: { model?: string; accountFor?: (runner: RunnerId) => Promise<AccountOption | undefined> } = {},
): Promise<{ workflow: WorkflowDef; route?: ModelRoute; notes?: string[] }> {
  const agents = workflow.steps.filter((step) => !step.command);
  const requested = modelAlias(options.model);
  const aliasFor = (step: { model?: string; runner?: RunnerId }) =>
    modelAlias(step.model) ?? (!step.model && !step.runner ? requested : undefined);
  const aliases = new Set(agents.flatMap((step) => aliasFor(step) ?? []));
  if (aliases.size === 0) return { workflow };
  const models = (await loadWorkspaceConfig()).factory?.models;
  const project = projectConfig ?? await loadConfig(repoRoot);
  const routes = new Map<ModelAlias, ModelRoute>();
  const notes: string[] = [];
  for (const alias of aliases) {
    const low = alias === LOW_REASONING_MODEL_ALIAS;
    const configured = low ? models?.lowReasoning : models?.highReasoning;
    if (!configured) {
      const runner = project.defaultRunner;
      const auto: Partial<Record<RunnerId, boolean>> | undefined = project.defaultModelsAuto;
      const model = auto?.[runner] ? '' : project.defaultModels?.[runner] ?? '';
      const reasoningEffort = low ? 'low' : 'high';
      routes.set(alias, { runner, model, ...(runnerSupportsReasoningEffort(runner) ? { reasoningEffort } : {}) });
      notes.push(`${alias} is unset in workspace settings. Using the project default runner (${runner}) with ${reasoningEffort} effort where supported.`);
      continue;
    }
    let route: ModelRoute = { runner: configured.runner, model: configured.model };
    const healthUrl = low ? models?.lowReasoning?.healthUrl : undefined;
    const fallbacks = models?.lowReasoningFallback;
    if (healthUrl && fallbacks?.length && !(await modelReachable(healthUrl))) {
      const candidates = (await Promise.all(fallbacks.map(async (fallback) => {
        const account = options.accountFor ? await options.accountFor(fallback.runner) : { runner: fallback.runner, account: 'default', label: 'default account' };
        return account && { ...account, model: fallback.model };
      }))).filter((candidate) => candidate !== undefined);
      if (candidates.length > 0) {
        const { chosen } = chooseTaskAgent(candidates, { explicitAccount: false, fromSettings: true, now: Date.now() });
        route = { runner: chosen.runner, model: chosen.model, agentProfile: chosen.agentProfile };
        notes.push(`Low-reasoning primary is unreachable. Using the hosted fallback on ${route.runner}.`);
      }
    }
    routes.set(alias, route);
  }
  function withModel<T extends { model?: string; runner?: RunnerId }>(step: T): T {
    const alias = aliasFor(step);
    const settings = alias && routes.get(alias);
    if (!settings) return step;
    const { runner, model, reasoningEffort } = settings;
    return { ...step, runner, model, ...(reasoningEffort ? { reasoningEffort } : {}) };
  }
  const graph = workflow.graph && {
    ...workflow.graph,
    nodes: workflow.graph.nodes.map((node) => node.type === 'agent' ? withModel(node) : node),
  };
  const steps = graph ? graphToSteps(graph) : workflow.steps.map((step) => step.command ? step : withModel(step));
  const first = agents[0] && aliasFor(agents[0]);
  const route = first && agents.every((step) => aliasFor(step) === first) ? routes.get(first) : undefined;
  return { workflow: { ...workflow, steps, ...(graph ? { graph } : {}) }, route, notes };
}

/**
 * The catalog's CURRENT entry under a queued run's snapshot name, when it differs from the
 * snapshot (#1078) — the definition that run should start with instead.
 *
 * `startRun` snapshots the workflow at creation (the record's `workflowDef`, #367), so a run that
 * waited in the queue while its file gained a step would otherwise run the old chain — while a
 * run started at that same instant gets the new one, because the loader has no cache. Only a
 * catalog entry is re-resolved: a workflow file, or the built-in `quick-task`. The ad-hoc chains
 * ("(planned)", "(inbox)") are `built-in` too but live on the record alone, so a file that
 * happens to share their name must never replace them. A file deleted or made invalid since the
 * run was queued is absent from the catalog, and the snapshot runs as before. That includes a file
 * that overrode `quick-task`: the loader then restores the built-in under the same name, so a
 * snapshot never moves from a file to a built-in — the file's steps would be silently dropped.
 *
 * Returns `undefined` when there is nothing newer to take. Compared through the persisted
 * schema, so a snapshot read back from `runs.json` (keys in schema order) and the same file
 * freshly loaded are equal.
 */
export function newerCatalogWorkflow(snapshot: WorkflowDef, catalog: readonly WorkflowDef[]): WorkflowDef | undefined {
  if (snapshot.source !== 'file' && snapshot.name !== QUICK_TASK_WORKFLOW.name) return undefined;
  const current = catalog.find((w) => w.name === snapshot.name);
  if (!current || (snapshot.source === 'file' && current.source !== 'file')) return undefined;
  const canonical = (def: WorkflowDef): string | undefined => {
    const parsed = workflowDefSchema.safeParse(def);
    return parsed.success ? JSON.stringify(parsed.data) : undefined;
  };
  const next = canonical(current);
  if (next === undefined || next === canonical(snapshot)) return undefined;
  return current;
}
