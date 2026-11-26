import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { replayRunInputSchema, replayRunResponseSchema, runIdParamSchema } from '@open-mercato/cezar-contract';
import { missingCockpitMessage } from '../cockpit-address.ts';
import { resolveCockpitProjectScope } from '../runtime/cockpit-project-scope.ts';

const USAGE = 'Usage: cez replay <run> [--times 1-5] [--harness v | --workflow w | --model m | --runner r | --effort e | --skill s | --brief text|file]';
const FLAGS = {
  times: { type: 'string' },
  harness: { type: 'string' },
  workflow: { type: 'string' },
  model: { type: 'string' },
  runner: { type: 'string' },
  effort: { type: 'string' },
  skill: { type: 'string' },
  brief: { type: 'string' },
} as const;

async function readBrief(value: string): Promise<string> {
  if (value.includes('\n') || value.includes('\0')) return value;
  const explicit = value.startsWith('@');
  const file = await open(explicit ? value.slice(1) : value, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)).catch((error: NodeJS.ErrnoException) => {
    if (!explicit && (error.code === 'ENOENT' || error.code === 'ENAMETOOLONG' || error.code === 'ENOTDIR')) return undefined;
    throw error;
  });
  if (!file) return value;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 400_000) throw new Error('Invalid brief file');
    return await file.readFile({ encoding: 'utf8' });
  } finally {
    await file.close();
  }
}

export async function runReplayCommand(
  args: string[], repoRoot: string, env = process.env,
  io: { fetch: typeof fetch; log(line: string): void; error(line: string): void } = { fetch, log: console.log, error: console.error },
): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { io.log(USAGE); return 0; }
  let parsed: ReturnType<typeof parseArgs<{ options: typeof FLAGS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args, options: FLAGS, allowPositionals: true });
  } catch {
    io.error(USAGE);
    return 2;
  }
  const id = runIdParamSchema.safeParse({ id: parsed.positionals[0] });
  const { times, brief, ...options } = parsed.values;
  const input = replayRunInputSchema.safeParse({ ...options, brief, times: times === undefined ? undefined : Number(times) });
  if (parsed.positionals.length !== 1 || !id.success || !input.success) { io.error(USAGE); return 2; }
  if (brief !== undefined) {
    try {
      const updated = replayRunInputSchema.parse({ ...input.data, brief: await readBrief(brief) });
      input.data = updated;
    } catch {
      io.error('cez replay: the replacement brief is empty, unreadable or too long.');
      return 2;
    }
  }
  const base = await resolveCockpitProjectScope(repoRoot, env, io.fetch);
  if (!base) {
    io.error(missingCockpitMessage({
      command: 'cez replay', example: 'cez replay <run>',
      insideTask: 'the cockpit did not provide an address for this task.',
    }, env));
    return 2;
  }
  try {
    const response = await io.fetch(`${base}/runs/${encodeURIComponent(id.data.id)}/replay`, {
      method: 'POST', body: JSON.stringify(input.data), headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json();
    if (!response.ok) {
      const error = body && typeof body === 'object' && 'error' in body ? body.error : undefined;
      io.error(`cez replay: ${typeof error === 'string' ? error : response.status}`);
      return 1;
    }
    const result = replayRunResponseSchema.parse(body);
    io.log(`Replay group ${result.groupId}\n${result.runs.join('\n')}`);
    return 0;
  } catch {
    io.error('cez replay: the cockpit did not answer the replay request.');
    return 1;
  }
}
