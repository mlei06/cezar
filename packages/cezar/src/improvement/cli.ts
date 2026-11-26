import { automationRunResponseSchema, FACTORY_IMPROVEMENT_AUTOMATION_ID } from '@open-mercato/cezar-contract';
import { resolveCockpitProjectScope } from '../runtime/cockpit-project-scope.ts';
import { missingCockpitMessage } from '../cockpit-address.ts';

const USAGE = 'Usage: cez improve';

export async function runImproveCommand(
  args: string[], repoRoot: string, env = process.env,
  io: { fetch: typeof fetch; log(line: string): void; error(line: string): void } = { fetch, log: console.log, error: console.error },
): Promise<number> {
  if (args.length) {
    if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { io.log(USAGE); return 0; }
    io.error(USAGE);
    return 2;
  }
  const base = await resolveCockpitProjectScope(repoRoot, env, io.fetch);
  if (!base) {
    io.error(missingCockpitMessage({
      command: 'cez improve', example: 'cez improve', insideTask: 'the cockpit did not provide a project address.',
    }, env));
    return 2;
  }
  try {
    const response = await io.fetch(base + '/automations/' + FACTORY_IMPROVEMENT_AUTOMATION_ID + '/run', {
      method: 'POST', signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json();
    if (!response.ok) {
      const error = body && typeof body === 'object' && 'error' in body ? body.error : undefined;
      io.error('cez improve: ' + (typeof error === 'string' ? error : response.status));
      return 1;
    }
    const { runId } = automationRunResponseSchema.parse(body);
    io.log('Queued improvement task ' + runId);
    return 0;
  } catch {
    io.error('cez improve: the cockpit did not answer the improvement request.');
    return 1;
  }
}
