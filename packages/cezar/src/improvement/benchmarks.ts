import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';
import { parse } from 'yaml';
import { z } from 'zod';
import { benchmarkMatrixRowSchema } from '@open-mercato/cezar-contract';
import { benchmarkResults, readBenchmarkBatches, runBenchmarkSuite } from '../benchmarks/run-suite.ts';
import { loadBenchmarkSuites } from '../benchmarks/suites.ts';
import { artifactsDir, type RunRecord, type RunStore } from '../runs/store.ts';
import { getHeadCommit } from '../server/git.ts';
import { atomicWriteJson } from '../workspace/config.ts';
import { loadWorkflows } from '../workflows/load.ts';
import type { RunManager } from '../workflows/run.ts';
import { committedImprovementPaths } from './workflow.ts';

const exec = promisify(execFile);
const WORKFLOW_PATH = /^\.ai\/cezar\/workflows\/[^/]+\.ya?ml$/iu;
const gateReceiptSchema = z.object({
  commit: z.string(),
  batches: z.array(z.object({ suite: z.string(), id: z.uuid() })),
  rows: z.array(benchmarkMatrixRowSchema).optional(),
});
const selectionSchema = z.object({
  id: z.string().optional(), type: z.string().optional(), model: z.string().optional(),
  runner: z.string().optional(), reasoningEffort: z.string().optional(),
});
const selectorsSchema = selectionSchema.extend({
  name: z.string(), steps: z.array(selectionSchema).optional(), nodes: z.array(selectionSchema).optional(),
});

function agentSelections(source: string | undefined) {
  if (!source) return;
  const doc = selectorsSchema.safeParse(parse(source));
  if (!doc.success) return;
  const { name, model, runner, reasoningEffort, steps, nodes } = doc.data;
  const choices = nodes ? nodes.filter((node) => node.type === 'agent') : steps ?? [];
  return {
    name, models: JSON.stringify({ model, runner, reasoningEffort, choices: choices
      .filter((entry) => entry.model || entry.runner || entry.reasoningEffort)
      .map(({ id, model, runner, reasoningEffort }) => ({ id, model, runner, reasoningEffort })) }),
  };
}

export function changedModelWorkflow(before: string | undefined, after: string | undefined): string | undefined {
  const original = agentSelections(before);
  const candidate = agentSelections(after);
  if (!candidate) return original?.models !== '{"choices":[]}' ? original?.name : undefined;
  if (candidate.models !== (original?.models ?? '{"choices":[]}')) return candidate.name;
}

export async function checkImprovementBenchmarks(input: {
  project: { root: string; dataDir: string; store: RunStore; manager: RunManager };
  cwd: string; run: RunRecord; cancelled: () => boolean;
}): Promise<{ ok: boolean; output: string } | undefined> {
  const { project, cwd, run } = input;
  if (!run.startCommit) return;
  const changed = (await committedImprovementPaths(cwd, run.startCommit)).filter((path) => WORKFLOW_PATH.test(path));
  if (!changed.length) return;
  const commit = await getHeadCommit(cwd);
  if (!commit) return { ok: false, output: 'The benchmark needs the improvement’s exact candidate commit.' };
  const names = new Set<string>();
  const definitionAt = (ref: string, path: string) =>
    exec('git', ['show', ref + ':' + path], { cwd, timeout: 5000, maxBuffer: 200_000 })
      .then(({ stdout }) => stdout).catch(() => undefined);
  for (const path of changed) {
    const [before, after] = await Promise.all([definitionAt(run.startCommit, path), definitionAt(commit, path)]);
    const name = changedModelWorkflow(before, after);
    if (name) names.add(name);
  }
  if (!names.size) return;
  const { workflows } = await loadWorkflows(cwd);
  const { suites } = await loadBenchmarkSuites(project.root);
  const matches = suites.flatMap((entry) => {
    const tasks = new Map([...entry.tasks].filter(([, task]) => names.has(task.workflow)));
    return tasks.size ? [{ ...entry, tasks }] : [];
  });
  if (!matches.length || [...names].some((name) => !matches.some(({ tasks }) => [...tasks.values()].some((task) => task.workflow === name)))) {
    return { ok: false, output: 'Add a saved benchmark for each workflow whose agent selection changed.' };
  }
  const reportPath = join(project.dataDir, 'factory', 'improvement-benchmarks', run.id + '.json');
  const saved = await readFile(reportPath, 'utf8').then((raw) => gateReceiptSchema.parse(JSON.parse(raw))).catch(() => undefined);
  const receipt = saved?.commit === commit ? saved : { commit, batches: [] };
  for (const entry of matches) {
    if (input.cancelled()) return { ok: false, output: 'Benchmark admission was cancelled.' };
    if (receipt.batches.some(({ suite }) => suite === entry.name)) continue;
    const candidate = await runBenchmarkSuite(project, entry.name, entry.suite, entry.tasks, undefined, workflows);
    if ('reason' in candidate) return { ok: false, output: candidate.reason };
    receipt.batches.push({ suite: entry.name, id: candidate.batch.id });
    await atomicWriteJson(reportPath, receipt);
  }
  const batches = receipt.batches.flatMap(({ suite, id }) =>
    readBenchmarkBatches(project.dataDir, suite).filter((batch) => batch.id === id));
  if (batches.length !== receipt.batches.length) return { ok: false, output: 'The benchmark batch records are incomplete.' };
  const until = Date.now() + 10 * 60_000;
  while (!input.cancelled() && Date.now() < until) {
    const partial = (await Promise.all(batches.map((batch) => benchmarkResults(project, batch)))).flatMap(({ rows }) => rows);
    if (partial.some(({ unavailable }) => unavailable > 0)) return { ok: false, output: 'A configured benchmark route is unavailable in replay.' };
    if (partial.every(({ unsettled, pending }) => unsettled === 0 && pending === 0)) {
      if (partial.some(({ missing, passed, failed }) => missing > 0 || passed + failed === 0)) {
        return { ok: false, output: 'The benchmark finished without all required scores.' };
      }
      await atomicWriteJson(reportPath, { ...receipt, rows: partial });
      await atomicWriteJson(join(artifactsDir(project.dataDir, run.id), 'improvement-benchmarks.json'), { commit, rows: partial });
      return { ok: true, output: 'The benchmark matrix was recorded with this improvement.' };
    }
    await setTimeout(2500);
  }
  for (const batch of batches) {
    for (const row of batch.runs) if (row.state === 'started') project.manager.cancel(row.runId);
  }
  return { ok: false, output: 'The benchmark check did not finish in time.' };
}

export async function improvementBenchmarkSummary(dataDir: string, run: RunRecord, currentCommit: string | null) {
  const path = join(dataDir, 'factory', 'improvement-benchmarks', run.id + '.json');
  const receipt = await readFile(path, 'utf8').then((raw) => gateReceiptSchema.parse(JSON.parse(raw))).catch(() => undefined);
  if (!receipt || receipt.commit !== currentCommit || !receipt.rows) return '';
  const rows = receipt.rows.map((row, index) =>
    '| ' + (index + 1) + ' | ' + row.passed + ' | ' + row.failed + ' | ' +
    (row.meanCostUsd?.toFixed(3) ?? '—') + ' | ' + (row.meanWallMs === undefined ? '—' : (row.meanWallMs / 1000).toFixed(1)) + ' |');
  return '\n\n## Benchmarks\n\n| Configuration | Passed | Failed | Mean cost (USD) | Mean time (s) |\n| --- | --- | --- | --- | --- |\n' + rows.join('\n');
}
