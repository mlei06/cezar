import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config.ts';
import { classifyAgentFailure } from '../core/agent-failure-class.ts';
import type { AgentRunResult, RunnerId } from '../core/agent-runner.ts';
import { OPENCODE_TOOL_FREE_UNAVAILABLE } from '../core/opencode-server-runner.ts';
import { createRunner } from '../core/runner-factory.ts';
import { oneShotAccountRef } from '../usage-ledger/identity.ts';
import { INTERNAL_CONSUMERS, trackOneShot } from '../usage-ledger/recorder.ts';
import { resolveProfileEnvForRoot } from '../workspace/agent-profiles.ts';
import { loadWorkspaceConfig } from '../workspace/config.ts';
import type { JudgeCall } from './evaluate.ts';

export interface JudgeRoute {
  runner: RunnerId;
  model?: string;
  call: JudgeCall;
}

export async function resolveJudgeRoute(repoRoot: string): Promise<JudgeRoute | { error: string }> {
  const [project, workspace] = await Promise.all([loadConfig(repoRoot), loadWorkspaceConfig()]);
  const configured = workspace.factory?.judge;
  const runner = configured?.runner ?? project.defaultRunner;
  if (runner !== 'codex' && runner !== 'claude' && runner !== 'opencode') {
    return { error: 'The judge needs a runner that can run with all tools disabled.' };
  }
  const model = configured?.model ?? project.defaultModels?.[runner];
  const { env, profile } = await resolveProfileEnvForRoot(repoRoot, runner);
  const account = await oneShotAccountRef(runner, profile);
  return {
    runner,
    ...(model ? { model } : {}),
    call: async ({ systemPrompt, userPrompt, timeoutMs }) => {
      const backend = createRunner(runner);
      const scratch = await mkdtemp(join(tmpdir(), 'cez-judge-'));
      const tracked = trackOneShot(runner, account, INTERNAL_CONSUMERS.scoring);
      let timedOut = false;
      let providerError: string | undefined;
      let result: AgentRunResult | undefined;
      const timer = setTimeout(() => {
        timedOut = true;
        void backend.interrupt().catch(() => undefined);
      }, timeoutMs);
      timer.unref?.();
      try {
        result = await backend.run({
          cwd: scratch, systemPrompt, userPrompt, allowedTools: [], noTools: true, enforceReadOnly: true, timeoutMs,
          env,
          ...(model ? { model } : {}),
          ...(!configured && runner !== 'opencode' ? { reasoningEffort: 'low' } : {}),
        }, (event) => {
          if (event.type === 'error') providerError = event.message;
          tracked.onEvent(event);
        });
        if (!timedOut && !providerError) return { text: result.text };
      } catch (error) {
        providerError ??= error instanceof Error ? error.message : String(error);
      } finally {
        clearTimeout(timer);
        tracked.done(result);
        await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
      }
      if (timedOut) return { timedOut: true };
      if (providerError === `opencode: ${OPENCODE_TOOL_FREE_UNAVAILABLE}`) return { error: OPENCODE_TOOL_FREE_UNAVAILABLE };
      if (classifyAgentFailure(providerError) === 'context_too_large') return { contextTooLarge: true };
      return { unavailable: true };
    },
  };
}
