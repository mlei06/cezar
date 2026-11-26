import { readdir, realpath } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { projectsResponseSchema, scoreRunInputSchema, scoreRunResponseSchema, runIdParamSchema } from '@open-mercato/cezar-contract';
import { missingCockpitMessage } from '../cockpit-address.ts';
import { cockpitRuntimeRoot, inspectCockpitRuntime } from '../runtime/cockpit-runtime.ts';

const USAGE = 'Usage: cez score <run> [--scorer <name>]';

async function scoringScope(repoRoot: string, env: NodeJS.ProcessEnv, fetcher: typeof fetch): Promise<string | undefined> {
  const explicit = env.CEZ_API_URL?.replace(/\/+$/, '');
  if (explicit && env.CEZ_PROJECT_ID) return `${explicit}/api/v1/p/${encodeURIComponent(env.CEZ_PROJECT_ID)}`;
  if (!explicit && (env.CEZ_TASK_ID || env.CEZ_MANAGER_ID)) return undefined;
  const origins = new Set(explicit ? [explicit] : []);
  if (!explicit) {
    const slots = await readdir(cockpitRuntimeRoot(env)).catch(() => []);
    for (const slot of slots) {
      const probe = await inspectCockpitRuntime(slot, { env, fetcher }).catch(() => undefined);
      if (probe?.kind === 'verified') origins.add(probe.runtime.origin);
    }
  }
  const root = await realpath(repoRoot).catch(() => repoRoot);
  for (const origin of origins) {
    try {
      const response = await fetcher(`${origin}/api/v1/projects`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) continue;
      const result = projectsResponseSchema.safeParse(await response.json());
      if (!result.success) continue;
      const project = result.data.projects.find((candidate) => candidate.root === root && candidate.status !== 'missing');
      if (project) return `${origin}/api/v1/p/${encodeURIComponent(project.id)}`;
    } catch {
      // A vanished cockpit does not prevent trying the remaining verified slots.
    }
  }
  return undefined;
}

export async function runScoreCommand(
  args: string[], repoRoot: string, env = process.env,
  io: { fetch: typeof fetch; log(line: string): void; error(line: string): void } = { fetch, log: console.log, error: console.error },
): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { io.log(USAGE); return 0; }
  let parsed: ReturnType<typeof parseArgs<{ options: { scorer: { type: 'string' } }; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args, options: { scorer: { type: 'string' } }, allowPositionals: true });
  } catch {
    io.error(USAGE);
    return 2;
  }
  const id = runIdParamSchema.safeParse({ id: parsed.positionals[0] });
  const input = scoreRunInputSchema.safeParse(parsed.values);
  if (parsed.positionals.length !== 1 || !id.success || !input.success) { io.error(USAGE); return 2; }
  const base = await scoringScope(repoRoot, env, io.fetch);
  if (!base) {
    io.error(missingCockpitMessage({
      command: 'cez score', example: 'cez score <run>',
      insideTask: 'the cockpit did not provide an address for this task.',
    }, env));
    return 2;
  }
  try {
    const response = await io.fetch(`${base}/runs/${encodeURIComponent(id.data.id)}/score`, {
      method: 'POST', body: JSON.stringify(input.data), headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json();
    if (!response.ok) {
      const error = body && typeof body === 'object' && 'error' in body ? body.error : undefined;
      io.error(`cez score: ${typeof error === 'string' ? error : response.status}`);
      return 1;
    }
    const result = scoreRunResponseSchema.parse(body);
    io.log(`Queued scoring for ${result.queued.join(', ')}.`);
    return 0;
  } catch {
    io.error('cez score: the cockpit did not answer the scoring request.');
    return 1;
  }
}
