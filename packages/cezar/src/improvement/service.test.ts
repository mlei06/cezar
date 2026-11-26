import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { QueuedCause } from '@open-mercato/cezar-contract';
import { projectCauseQueuePath, readCauseQueue } from '../factory/causes.ts';
import { artifactsDir, type RunRecord } from '../runs/store.ts';
import { IMPROVE_FACTORY, IMPROVE_FACTORY_DECISIONS_FILE } from '../workflows/templates.ts';
import { atomicWriteJsonSync } from '../workspace/config.ts';
import { projectImprovementRecordsPath, readImprovementRecords } from './bookkeeping.ts';
import { ImprovementService, type ImprovementProject } from './service.ts';
import { improvementDefaults } from './settings.ts';

const now = new Date('2026-03-01T00:00:00.000Z');
const cause = (id: string): QueuedCause => ({
  id, projectId: 'fixture', runId: `run-${id}`, scorer: 'efficiency', label: 'wasteful', reasoning: 'Polled the test run.',
  cause: { category: 'task-setup', target: 'workflow', evidence: 'sleep 30', fix: 'Wait inside one command.' }, at: '2026-02-27T00:00:00.000Z', state: 'open',
});

let root: string;
let runs: Map<string, RunRecord>;
let listeners: Array<(run: RunRecord) => void>;
let briefs: string[];
let prState: 'open' | 'merged' | 'closed' | undefined;
const project = (): ImprovementProject => ({
  id: 'fixture', root, dataDir: join(root, 'data'),
  listRuns: () => [...runs.values()],
  getRun: (id) => runs.get(id),
  onRun: (listener) => { listeners.push(listener); return () => { listeners = listeners.filter((entry) => entry !== listener); }; },
  startRun: async (task) => { briefs.push(task); const id = `imp-run-${briefs.length}`; runs.set(id, { id, status: 'running' } as RunRecord); return { id }; },
});
const service = () => new ImprovementService({
  isHarness: async () => false,
  settings: async () => improvementDefaults(false),
  prState: async () => prState,
  now: () => now,
});
const finish = (id: string, change: Partial<RunRecord>) => {
  const run = { ...runs.get(id)!, ...change } as RunRecord;
  runs.set(id, run);
  return run;
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cez-improve-service-'));
  runs = new Map();
  listeners = [];
  briefs = [];
  prState = undefined;
  atomicWriteJsonSync(projectCauseQueuePath(join(root, 'data')), ['a', 'b', 'c', 'd', 'e'].map(cause));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('is a valid workflow that runs the skill, checks, then opens the PR', () => {
  expect(IMPROVE_FACTORY.graph?.nodes.map((node) => node.type)).toEqual(['start', 'agent', 'check', 'loop', 'end', 'agent', 'github.draft-pr', 'end']);
  expect(IMPROVE_FACTORY.graph?.nodes[1]).toMatchObject({ skill: 'improve-factory' });
});

it('starts a run from a full queue with a brief naming every cause, then applies its decisions', async () => {
  const improvement = service();
  const started = await improvement.start(project(), { startedBy: 'automation', manual: false });
  expect(started).toMatchObject({ started: true, runId: 'imp-run-1', causes: 5 });
  expect(briefs[0]).toContain('### a');
  expect(briefs[0]).toContain('/p/fixture/runs/run-e');
  expect(briefs[0]).toContain('Scope: you may change docs, agents-md, skills, workflows, code');
  expect(await improvement.start(project(), { startedBy: 'owner', manual: true })).toMatchObject({ started: false, reason: expect.stringContaining('still running') });

  const dir = artifactsDir(join(root, 'data'), 'imp-run-1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, IMPROVE_FACTORY_DECISIONS_FILE), JSON.stringify({ clusters: [
    { id: 'polling', causes: ['a', 'b', 'c'], decision: 'fixed', reason: 'The workflow waits in one command now.' },
    { id: 'rest', causes: ['d', 'e'], decision: 'deferred', reason: 'Needs more runs.' },
  ] }));
  await improvement.settle(project(), finish('imp-run-1', { status: 'review', pullRequestUrl: 'https://github.com/o/r/pull/12' }));
  expect(readImprovementRecords(projectImprovementRecordsPath(join(root, 'data')))[0]).toMatchObject({ state: 'pr-open', pr: { number: 12 } });
  expect(readCauseQueue(projectCauseQueuePath(join(root, 'data'))).map((entry) => entry.state)).toEqual(['processed', 'processed', 'processed', 'open', 'open']);

  prState = 'merged';
  expect(await improvement.start(project(), { startedBy: 'owner', manual: true })).toMatchObject({ started: false, reason: expect.stringContaining('cooldown') });
  expect(readImprovementRecords(projectImprovementRecordsPath(join(root, 'data')))[0]).toMatchObject({ state: 'merged', mergedAt: now.toISOString() });
});

it('returns the batch when the run fails or leaves no decisions file', async () => {
  const improvement = service();
  await improvement.start(project(), { startedBy: 'automation', manual: false });
  await improvement.settle(project(), finish('imp-run-1', { status: 'done' }));
  expect(readImprovementRecords(projectImprovementRecordsPath(join(root, 'data')))[0]).toMatchObject({ state: 'failed' });
  expect(readCauseQueue(projectCauseQueuePath(join(root, 'data'))).every((entry) => entry.state === 'open')).toBe(true);

  await improvement.start(project(), { startedBy: 'owner', manual: true });
  const stop = improvement.watch(project());
  listeners.forEach((listener) => listener(finish('imp-run-2', { status: 'cancelled' })));
  await new Promise((resolve) => setTimeout(resolve, 20));
  stop();
  expect(readImprovementRecords(projectImprovementRecordsPath(join(root, 'data')))[1]).toMatchObject({ state: 'failed' });
});

it('reports a launcher refusal without claiming anything', async () => {
  const refusing = { ...project(), startRun: async () => ({ error: 'the improve-factory skill is not installed' }) };
  expect(await service().start(refusing, { startedBy: 'owner', manual: true })).toEqual({ started: false, reason: 'the improve-factory skill is not installed' });
  expect(readCauseQueue(projectCauseQueuePath(join(root, 'data'))).every((entry) => entry.state === 'open')).toBe(true);
});
