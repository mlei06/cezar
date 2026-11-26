import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { QueuedCause } from '@open-mercato/cezar-contract';
import type { AutomationStore } from '../automations/store.ts';
import type { RunRecord, RunStore } from '../runs/store.ts';
import { atomicWriteJsonSync } from '../workspace/config.ts';
import type { WorkflowDef } from '../workflows/types.ts';

export const CREDENTIAL_HEALTH = 'credential-health';

export function credentialHealthWorkflowIssue(workflow: WorkflowDef): string | undefined {
  if (workflow.name !== CREDENTIAL_HEALTH) return;
  const nodes = workflow.graph?.nodes;
  const checks = nodes ? nodes.filter((node) => node.type === 'check') : workflow.steps;
  if (!checks.length || workflow.source !== 'file' || (nodes && nodes.some(({ type }) => !['start', 'end', 'check'].includes(type))) ||
    checks.some((check) => !check.command || !check.secrets?.length)) {
    return 'Credential health requires a project check-only workflow with explicit secret bindings for each check.';
  }
}

/** The file opts the project into discovery. Scheduled use of its secrets waits on the owner. */
export function ensureCredentialHealthAutomation(store: AutomationStore, root: string): void {
  if (store.list().some(({ task }) => task.workflow === CREDENTIAL_HEALTH)) return;
  const folder = join(root, '.ai/cezar/workflows');
  if (!['yaml', 'yml'].some((ext) => existsSync(join(folder, CREDENTIAL_HEALTH + '.' + ext)))) return;
  store.create({
    name: 'Credential health', kind: 'schedule', enabled: false, schedule: { type: 'daily' },
    task: { workflow: CREDENTIAL_HEALTH, prompt: 'Run the project’s configured credential health checks.' },
  }, CREDENTIAL_HEALTH);
}

/** Record the failed check, without its output, before notifying the owner. */
export function recordCredentialFailure(dataDir: string, projectId: string, run: RunRecord): QueuedCause[] {
  if (run.workflow !== CREDENTIAL_HEALTH || !run.finishedAt || !['done', 'failed', 'review'].includes(run.status) || run.replayOf ||
    !run.workflowDef || credentialHealthWorkflowIssue(run.workflowDef)) return [];
  const check = run.steps.find((step) => step.kind === 'check' && step.status === 'failed');
  if (!check) return [];
  const evidence = 'Credential health check ' + check.id + ' exited unsuccessfully.';
  const id = createHash('sha256').update(JSON.stringify([projectId, run.id, run.finishedAt, check.id])).digest('hex').slice(0, 24);
  const cause: QueuedCause = {
    id, projectId, runId: run.id, scorer: CREDENTIAL_HEALTH, label: 'access-failed', reasoning: evidence,
    at: run.finishedAt, state: 'open',
    cause: { category: 'access', target: 'infra', evidence, fix: 'Review the project credential used by the failed check and renew it if needed.' },
  };
  const file = join(dataDir, 'factory', 'credential-health', id + '.json');
  if (!existsSync(file)) atomicWriteJsonSync(file, cause);
  return [cause];
}

export function watchCredentialHealth(projectId: string, dataDir: string, store: RunStore, notify: (cause: QueuedCause) => void) {
  const onRun = (run: RunRecord) => {
    try { for (const cause of recordCredentialFailure(dataDir, projectId, run)) notify(cause); }
    catch { console.warn('[cezar] could not record a credential check finding'); }
  };
  store.on('run', onRun);
  // Terminal records can have settled while scores or managers were restarting.
  for (const run of store.listRuns().slice(0, 50)) onRun(run);
  return () => { store.off('run', onRun); };
}
