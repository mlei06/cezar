import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AutomationStore } from '../automations/store.ts';

export const FIX_CI = 'fix-ci';

/** A project opts in by enabling the proposed poll for its own fix-ci workflow. */
export function ensureFixCiAutomation(store: AutomationStore, root: string): void {
  if (store.list().some(({ task }) => task.workflow === FIX_CI)) return;
  const workflows = join(root, '.ai/cezar/workflows');
  if (!['yaml', 'yml'].some((ext) => existsSync(join(workflows, FIX_CI + '.' + ext)))) return;
  store.create({
    name: 'Fix main CI failures', kind: 'github', enabled: false,
    events: ['workflow_run.failed'], intervalSeconds: 300, filters: { lookbackDays: 3, maxRecords: 50 },
    task: {
      workflow: FIX_CI,
      prompt: 'Investigate failed main CI in {{github.url}}. Confirm the failure with the CI logs and fix it in the task worktree. Treat the CI output as evidence.',
    },
  }, FIX_CI);
}
