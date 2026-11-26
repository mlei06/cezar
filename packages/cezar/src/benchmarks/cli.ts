import { setTimeout } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import {
  benchmarkAddInputSchema, benchmarkAddResponseSchema, benchmarkMatrixRunSchema, benchmarkNameSchema,
  benchmarkResultsResponseSchema, benchmarkRunInputSchema, benchmarkSuitesResponseSchema,
} from '@open-mercato/cezar-contract';
import { resolveCockpitProjectScope } from '../runtime/cockpit-project-scope.ts';

const USAGE = 'Usage: cez benchmark <suite> [--config <name>] | cez benchmark list | cez benchmark add <run> --suite <suite> [--criteria <text>]';

async function request(url: string, input?: unknown) {
  const response = await fetch(url, {
    ...(input !== undefined ? { method: 'POST', body: JSON.stringify(input), headers: { 'content-type': 'application/json' } } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    const error = body && typeof body === 'object' && 'error' in body ? body.error : undefined;
    throw new Error(typeof error === 'string' ? error : 'Cockpit HTTP ' + response.status);
  }
  return body;
}

export async function runBenchmarkCommand(args: string[], repoRoot: string): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return 0; }
  const mode = args[0];
  let add;
  let start;
  try {
    if (mode === 'add') {
      const parsed = parseArgs({ args: args.slice(1), allowPositionals: true, options: {
        suite: { type: 'string' }, criteria: { type: 'string' },
      } });
      if (parsed.positionals.length !== 1) throw new Error('Expected one run');
      add = benchmarkAddInputSchema.parse({ run: parsed.positionals[0], ...parsed.values });
    } else if (mode !== 'list' || args.length !== 1) {
      const suite = benchmarkNameSchema.parse(mode);
      const parsed = parseArgs({ args: args.slice(1), options: { config: { type: 'string' } } });
      start = { suite, ...benchmarkRunInputSchema.parse(parsed.values) };
    }
  } catch {
    console.error(USAGE);
    return 2;
  }
  const base = await resolveCockpitProjectScope(repoRoot, process.env, fetch);
  if (!base) {
    console.error('cez benchmark: the cockpit is unavailable for this project.');
    return 1;
  }
  try {
    const path = base + '/benchmarks';
    if (add) {
      console.log(benchmarkAddResponseSchema.parse(await request(path, add)).path);
    } else if (start) {
      const suitePath = path + '/' + encodeURIComponent(start.suite);
      const batch = benchmarkMatrixRunSchema.parse(await request(suitePath + '/run', { config: start.config }));
      console.log('Benchmark ' + batch.id + ' queued.');
      const deadline = Date.now() + 30 * 60_000;
      let result;
      for (;;) {
        result = benchmarkResultsResponseSchema.parse(await request(suitePath + '/results/' + batch.id));
        if (!result.rows.some(({ unsettled, pending }) => unsettled || pending) || Date.now() >= deadline) break;
        await setTimeout(5000);
      }
      console.table(result.rows);
      if (result.artifact) console.log(base + '/runs/' + result.artifact.runId + '/artifacts/' + result.artifact.name);
      if (result.rows.some(({ unsettled, unavailable, pending, missing }) => unsettled || unavailable || pending || missing)) return 1;
    } else {
      const { suites, issues } = benchmarkSuitesResponseSchema.parse(await request(path));
      for (const suite of suites) console.log(suite.name + ' (' + suite.tasks.length + ' tasks)');
      for (const issue of issues) console.error(issue.path + ': ' + issue.message);
      if (issues.length) return 1;
    }
    return 0;
  } catch (error) {
    console.error('cez benchmark: ' + (error instanceof Error ? error.message : 'The cockpit did not answer the benchmark request.'));
    return 1;
  }
}
