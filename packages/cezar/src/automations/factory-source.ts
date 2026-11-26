import { FACTORY_IMPROVEMENT_AUTOMATION_ID as FACTORY_AUTOMATION, type ImprovementRecord } from '@open-mercato/cezar-contract';
import { startFactoryImprovement } from '../improvement/start.ts';
import { IMPROVE_FACTORY } from '../improvement/workflow.ts';
import type { ProjectContext } from '../server/project-context.ts';
import type { AutomationStore } from './store.ts';
import type { AutomationDefinition } from './types.ts';

export { FACTORY_AUTOMATION };
export const FACTORY_INTERVAL_SECONDS = 3600;

export function ensureFactoryAutomation(store: AutomationStore, now = Date.now()): void {
  if (store.get(FACTORY_AUTOMATION)) return;
  store.create({
    name: 'Improve the factory',
    kind: 'factory',
    enabled: true,
    intervalSeconds: FACTORY_INTERVAL_SECONDS,
    task: { workflow: IMPROVE_FACTORY, prompt: 'Improve this project from its scored cause queue.' },
  }, FACTORY_AUTOMATION, (definition) => {
    store.setState(definition.id, () => ({
      revision: definition.revision, nextCheckAt: new Date(now + FACTORY_INTERVAL_SECONDS * 1_000).toISOString(),
    }));
  });
}

export async function runFactoryAutomation(options: {
  project: Pick<ProjectContext, 'id' | 'root' | 'dataDir' | 'manager' | 'store'>;
  store: AutomationStore;
  definition: AutomationDefinition;
  startedBy: ImprovementRecord['startedBy'];
  now?: () => number;
}): Promise<{ runId: string } | { reason: string }> {
  const { project, store, definition, startedBy, now = Date.now } = options;
  const lease = store.acquireLease();
  if (!lease) return { reason: 'another factory or automation check is in progress' };
  const mutation = store.acquireMutationLease();
  if (!mutation) {
    lease.release();
    return { reason: 'another factory or automation check is in progress' };
  }
  try {
    const current = store.get(definition.id);
    const automatic = startedBy === 'automation';
    if (!current || current.kind !== 'factory' || current.id !== FACTORY_AUTOMATION || current.revision !== definition.revision ||
      (automatic && !current.enabled)) return { reason: 'the factory automation changed' };
    const log = { automationId: current.id, revision: current.revision };
    if (automatic) {
      const due = Date.parse(store.state(current.id)?.nextCheckAt ?? '');
      if (Number.isFinite(due) && due > now()) return { reason: 'the factory automation is not due' };
      store.setState(current.id, (state) => ({
        ...state, revision: current.revision, nextCheckAt: new Date(now() + FACTORY_INTERVAL_SECONDS * 1_000).toISOString(),
      }));
    }
    try {
      const result = await startFactoryImprovement(project, startedBy, {
        automationId: current.id, automationRevision: current.revision,
        occurrenceAt: new Date(now()).toISOString(),
      });
      if ('reason' in result) {
        store.appendLog({ ...log, result: 'skipped', reason: result.reason });
        return result;
      }
      store.appendLog({ ...log, result: automatic ? 'launched' : 'manual', runId: result.run.id });
      return { runId: result.run.id };
    } catch {
      const reason = 'factory improvement could not be admitted';
      store.appendLog({ ...log, result: 'error', reason });
      return { reason };
    }
  } finally {
    mutation.release();
    lease.release();
  }
}
