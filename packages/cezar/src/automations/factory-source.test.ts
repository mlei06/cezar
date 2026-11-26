import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ProjectContext } from '../server/project-context.ts';
import { startFactoryImprovement } from '../improvement/start.ts';
import { ensureFactoryAutomation, FACTORY_AUTOMATION, runFactoryAutomation } from './factory-source.ts';
import { AutomationStore } from './store.ts';

vi.mock('../improvement/start.ts', () => ({ startFactoryImprovement: vi.fn() }));

let root: string;
let store: AutomationStore;
const now = Date.parse('2026-02-10T12:00:00Z');
const hour = 60 * 60_000;
const project = { id: 'fixture' } as ProjectContext;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cez-factory-source-'));
  store = AutomationStore.open(root);
  vi.resetAllMocks();
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

it('checks once per hour and records why the factory did not launch', async () => {
  ensureFactoryAutomation(store, now);
  ensureFactoryAutomation(store, now);
  expect(store.list()).toHaveLength(1);
  const definition = store.get(FACTORY_AUTOMATION)!;
  expect(definition).toMatchObject({ kind: 'factory', enabled: true, intervalSeconds: 3600 });
  const check = (at: number) => runFactoryAutomation({ project, store, definition, startedBy: 'automation', now: () => at });
  await expect(check(now)).resolves.toMatchObject({ reason: 'the factory automation is not due' });
  expect(startFactoryImprovement).not.toHaveBeenCalled();
  vi.mocked(startFactoryImprovement).mockResolvedValue({ reason: 'no open causes' });
  await expect(check(now + hour)).resolves.toEqual({ reason: 'no open causes' });
  expect(store.logs({ automationId: definition.id })).toMatchObject([{ result: 'skipped', reason: 'no open causes' }]);
  expect(store.state(definition.id)?.nextCheckAt).toBe(new Date(now + 2 * hour).toISOString());
  await expect(check(now + hour)).resolves.toMatchObject({ reason: 'the factory automation is not due' });
  expect(startFactoryImprovement).toHaveBeenCalledTimes(1);
});

it('uses the same lease for manual starts and leaves the next hourly check due', async () => {
  ensureFactoryAutomation(store, now);
  const definition = store.get(FACTORY_AUTOMATION)!;
  vi.mocked(startFactoryImprovement).mockResolvedValue({ reason: 'cooldown' });
  const check = () => runFactoryAutomation({ project, store, definition, startedBy: 'manager', now: () => now });
  const outcomes = await Promise.all([check(), check()]);
  expect(outcomes).toEqual([{ reason: 'cooldown' }, { reason: 'another factory or automation check is in progress' }]);
  expect(startFactoryImprovement).toHaveBeenCalledTimes(1);
  expect(startFactoryImprovement).toHaveBeenCalledWith(project, 'manager', expect.objectContaining({ automationId: definition.id }));
  expect(store.state(definition.id)?.nextCheckAt).toBe(new Date(now + hour).toISOString());
  expect(store.logs({ automationId: definition.id })).toMatchObject([{ result: 'skipped', reason: 'cooldown' }]);
});
