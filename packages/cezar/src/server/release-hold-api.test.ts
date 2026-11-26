import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { releaseHoldStatusSchema } from '@open-mercato/cezar-contract';
import { expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { RunManager } from '../workflows/run.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

it('drains active tasks, holds the next task, and starts it after release', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-release-hold-api-'));
  vi.stubEnv('CEZ_HOME', join(root, 'workspace'));
  const store = RunStore.open(join(root, '.ai/cezar'));
  const semaphore = new WorkspaceSemaphore({ releaseHold: true, initial: { maxParallel: 2 } });
  const manager = new RunManager(store, root, { semaphore });
  const dispose: Array<() => void> = [];
  const app = createApp({ repoRoot: root, store, manager, semaphore, version: 'fixture', onDispose: (action) => dispose.push(action) });
  const url = '/api/v1/workspace/factory/release-hold';
  try {
    const drain = manager.startRun({ name: 'drain', source: 'file', steps: [{ id: 'check', command: 'sleep 0.75' }] }, { task: 'drain', worktree: false });
    await vi.waitFor(() => expect(drain.status).toBe('running'));
    const hold = await apiRequest(app, url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"seconds":40}' });
    expect(hold.status).toBe(201);
    const lease = releaseHoldStatusSchema.parse(await hold.json());
    expect(lease).toMatchObject({ activeTasks: 1, activeManagers: 0 });

    const queued = manager.startRun({ name: 'next', source: 'file', steps: [{ id: 'check', command: 'true' }] }, { task: 'next', worktree: false });
    await vi.waitFor(() => expect(drain.status).toBe('done'));
    await semaphore.release();
    await wait(400);
    expect(queued.status).toBe('queued');
    const state = await apiRequest(app, url + '/' + lease.id);
    expect(releaseHoldStatusSchema.parse(await state.json())).toMatchObject({ activeTasks: 0 });
    expect((await apiRequest(app, url + '/' + lease.id, { method: 'DELETE' })).status).toBe(200);
    await vi.waitFor(() => expect(queued.status).toBe('done'));
  } finally {
    const current = semaphore.releaseHold?.current();
    if (current) semaphore.releaseHold?.release(current.id);
    for (const action of dispose) action();
    manager.dispose();
    store.flush();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);
