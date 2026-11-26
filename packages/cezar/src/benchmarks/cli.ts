import { parseArgs } from 'node:util';
import { benchmarkAddInputSchema, benchmarkAddResponseSchema, benchmarkSuitesResponseSchema } from '@open-mercato/cezar-contract';
import { resolveCockpitProjectScope } from '../runtime/cockpit-project-scope.ts';

const USAGE = 'Usage: cez benchmark list | cez benchmark add <run> --suite <suite> [--criteria <text>]';

export async function runBenchmarkCommand(args: string[], repoRoot: string): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return 0; }
  const mode = args[0];
  let input;
  if (mode === 'add') {
    try {
      const parsed = parseArgs({ args: args.slice(1), allowPositionals: true, options: {
        suite: { type: 'string' }, criteria: { type: 'string' },
      } });
      if (parsed.positionals.length !== 1) throw new Error('Expected one run');
      input = benchmarkAddInputSchema.parse({ run: parsed.positionals[0], ...parsed.values });
    } catch {
      console.error(USAGE);
      return 2;
    }
  } else if (mode !== 'list' || args.length !== 1) {
    console.error(USAGE);
    return 2;
  }
  const base = await resolveCockpitProjectScope(repoRoot, process.env, fetch);
  if (!base) {
    console.error('cez benchmark: the cockpit is unavailable for this project.');
    return 1;
  }
  try {
    const result = await fetch(base + '/benchmarks', {
      ...(input ? { method: 'POST', body: JSON.stringify(input), headers: { 'content-type': 'application/json' } } : {}),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await result.json();
    if (!result.ok) {
      const error = body && typeof body === 'object' && 'error' in body ? body.error : undefined;
      console.error('cez benchmark: ' + (typeof error === 'string' ? error : result.status));
      return 1;
    }
    if (input) {
      console.log(benchmarkAddResponseSchema.parse(body).path);
    } else {
      const { suites, issues } = benchmarkSuitesResponseSchema.parse(body);
      for (const suite of suites) console.log(suite.name + ' (' + suite.tasks.length + ' tasks)');
      for (const issue of issues) console.error(issue.path + ': ' + issue.message);
      if (issues.length) return 1;
    }
    return 0;
  } catch {
    console.error('cez benchmark: the cockpit did not answer the benchmark request.');
    return 1;
  }
}
