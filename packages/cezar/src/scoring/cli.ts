import { parseArgs } from 'node:util';
import { scoreRunInputSchema, scoreRunResponseSchema, runIdParamSchema } from '@open-mercato/cezar-contract';
import { missingCockpitMessage } from '../cockpit-address.ts';
import { resolveCockpitProjectScope } from '../runtime/cockpit-project-scope.ts';

const USAGE = 'Usage: cez score <run> [--scorer <name>]';

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
  const base = await resolveCockpitProjectScope(repoRoot, env, io.fetch);
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
