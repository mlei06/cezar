import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ImprovementRecord, QueuedCause } from '@open-mercato/cezar-contract';
import { readCauseQueue } from '../factory/causes.ts';
import { atomicWriteJsonSync } from '../workspace/config.ts';
import {
  closeImprovement, failImprovement, finishImprovement, mergeImprovement, readImprovementDecisions,
  readImprovementRecords, startImprovement, type ImprovementPaths,
} from './bookkeeping.ts';
import { improvementDefaults, resolveImprovementSettings } from './settings.ts';
import { evaluateImprovementTrigger, FAILURE_PAUSE, MAX_BATCH } from './trigger.ts';

const now = new Date('2026-02-10T12:00:00.000Z');
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
const cause = (id: string, at = daysAgo(1), state: QueuedCause['state'] = 'open'): QueuedCause => ({
  id, projectId: 'fixture', runId: `run-${id}`, scorer: 'efficiency', label: 'wasteful', reasoning: 'Observed.',
  cause: { category: 'task-setup', target: 'workflow', evidence: 'Observed line.', fix: 'Change it.' }, at, state,
});
const record = (id: string, state: ImprovementRecord['state'], extra: Partial<ImprovementRecord> = {}): ImprovementRecord => ({
  id, queue: 'project', projectId: 'fixture', startedBy: 'automation', startedAt: daysAgo(5), causeIds: [], state, ...extra,
});
const project = improvementDefaults(false);
const harness = improvementDefaults(true);
const trigger = (over: Partial<Parameters<typeof evaluateImprovementTrigger>[0]>) =>
  evaluateImprovementTrigger({ queue: [], records: [], settings: project, scoredRunsSinceMerge: 0, now, ...over });

describe('improvement settings', () => {
  it('uses the one-person defaults, then workspace, then project, and honours the env switch', () => {
    expect(project).toMatchObject({ threshold: 5, ageDays: 3, minForAge: 2, cooldownRuns: 5, cooldownDays: 3, approval: 'manager' });
    expect(harness).toMatchObject({ ageDays: 7, cooldownRuns: 10 });
    expect(harness.cooldownDays).toBeUndefined();
    const resolved = resolveImprovementSettings({
      harness: false, workspace: { threshold: 8, approval: 'owner' }, project: { threshold: 3, scope: ['docs', 'docs'] }, env: {},
    });
    expect(resolved).toMatchObject({ threshold: 3, approval: 'owner', scope: ['docs'], enabled: true });
    expect(resolveImprovementSettings({ harness: false, env: { CEZ_SELF_IMPROVEMENT: '0' } }).enabled).toBe(false);
  });
});

describe('improvement trigger', () => {
  it('fires at the threshold, or on an old enough queue with the minimum, and not below', () => {
    const four = ['a', 'b', 'c', 'd'].map((id) => cause(id));
    expect(trigger({ queue: four })).toEqual({ fire: false, reason: '4 open causes, below the threshold of 5' });
    const five = [...four, cause('e')];
    expect(trigger({ queue: five })).toMatchObject({ fire: true, batch: { length: 5 } });
    expect(trigger({ queue: [cause('old', daysAgo(4)), cause('new')] })).toMatchObject({ fire: true });
    expect(trigger({ queue: [cause('old', daysAgo(4))] })).toMatchObject({ fire: false });
    expect(trigger({ queue: [cause('old', daysAgo(4)), cause('new')], settings: harness })).toMatchObject({ fire: false });
  });

  it('counts only open causes, oldest first, capped per batch', () => {
    const queue = [cause('done', daysAgo(9), 'processed'), ...Array.from({ length: MAX_BATCH + 5 }, (_, i) => cause(`c${i}`, daysAgo(i % 3)))];
    const result = trigger({ queue });
    expect(result.fire && result.batch).toHaveLength(MAX_BATCH);
    expect(result.fire && result.batch.every((entry) => entry.state === 'open')).toBe(true);
    expect(result.fire && result.batch[0]!.at <= result.batch[1]!.at).toBe(true);
  });

  it('keeps one run at a time and the cooldown, even for a manual start', () => {
    const queue = ['a', 'b', 'c', 'd', 'e'].map((id) => cause(id));
    expect(trigger({ queue, records: [record('i1', 'running')], manual: true })).toMatchObject({ fire: false, reason: expect.stringContaining('still running') });
    expect(trigger({ queue, records: [record('i1', 'pr-open')] })).toMatchObject({ fire: false, reason: expect.stringContaining('PR') });
    const merged = record('i1', 'merged', { mergedAt: daysAgo(1) });
    expect(trigger({ queue, records: [merged], scoredRunsSinceMerge: 2, manual: true })).toMatchObject({ fire: false, reason: expect.stringContaining('cooldown') });
    expect(trigger({ queue, records: [merged], scoredRunsSinceMerge: 5 })).toMatchObject({ fire: true });
    expect(trigger({ queue, records: [record('i1', 'merged', { mergedAt: daysAgo(4) })], scoredRunsSinceMerge: 0 })).toMatchObject({ fire: true });
    expect(trigger({ queue, records: [record('i1', 'merged', { mergedAt: daysAgo(30) })], settings: harness, scoredRunsSinceMerge: 9 }))
      .toMatchObject({ fire: false, reason: expect.stringContaining('1 more scored runs') });
  });

  it('lets a manual start skip the threshold and the failure pause, never an empty queue or a disabled setting', () => {
    const failures = Array.from({ length: FAILURE_PAUSE }, (_, i) => record(`f${i}`, 'failed', { startedAt: daysAgo(i) }));
    const queue = ['a', 'b', 'c', 'd', 'e'].map((id) => cause(id));
    expect(trigger({ queue, records: failures })).toMatchObject({ fire: false, reason: expect.stringContaining('paused') });
    expect(trigger({ queue, records: failures, manual: true })).toMatchObject({ fire: true });
    expect(trigger({ queue: [cause('one')], manual: true })).toMatchObject({ fire: true, batch: { length: 1 } });
    expect(trigger({ queue: [], manual: true })).toEqual({ fire: false, reason: 'no open causes' });
    expect(trigger({ queue, settings: { ...project, enabled: false }, manual: true })).toMatchObject({ fire: false });
  });
});

describe('improvement bookkeeping', () => {
  let root: string;
  let paths: ImprovementPaths;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-improvement-'));
    paths = { queue: join(root, 'queue.json'), records: join(root, 'improvements.json'), harnessQueue: join(root, 'harness-queue.json') };
    atomicWriteJsonSync(paths.queue, ['fix', 'drop', 'up', 'later', 'silent'].map((id) => cause(id)).concat(cause('other')));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const start = () => startImprovement(paths, {
    id: 'imp1', projectId: 'fixture', startedBy: 'automation', startedAt: now.toISOString(),
    batch: ['fix', 'drop', 'up', 'later', 'silent'].map((id) => cause(id)),
  });
  const states = (path = paths.queue) => Object.fromEntries(readCauseQueue(path).map((entry) => [entry.id, entry.state]));

  it('claims the batch, then applies each decision and escalates to the harness queue', () => {
    expect(start()).toMatchObject({ state: 'running', queue: 'project', causeIds: ['fix', 'drop', 'up', 'later', 'silent'] });
    expect(states()).toMatchObject({ fix: 'processing', other: 'open' });
    const finished = finishImprovement(paths, 'imp1', {
      now, pr: { number: 7 },
      decisions: { clusters: [
        { id: 'a', causes: ['fix', 'not-in-batch'], decision: 'fixed', reason: 'Redrafted the workflow.' },
        { id: 'b', causes: ['drop'], decision: 'dismissed', reason: 'Evidence not confirmed.' },
        { id: 'c', causes: ['up'], decision: 'escalated', reason: 'Every project hits this.' },
        { id: 'd', causes: ['later'], decision: 'deferred', reason: 'Outside scope.' },
      ] },
    });
    expect(finished).toMatchObject({ state: 'pr-open', pr: { number: 7 }, clusters: { length: 4 } });
    expect(states()).toEqual({ fix: 'processed', drop: 'dismissed', up: 'escalated', later: 'open', silent: 'open', other: 'open' });
    expect(readCauseQueue(paths.harnessQueue!)).toEqual([expect.objectContaining({ id: 'up', state: 'open', projectId: 'fixture' })]);
  });

  it('claims only causes that are still open', () => {
    atomicWriteJsonSync(paths.queue, [cause('free'), cause('held', undefined, 'processing'), cause('gone', undefined, 'dismissed')]);
    const claimed = startImprovement(paths, {
      id: 'imp2', projectId: 'fixture', startedBy: 'owner', startedAt: now.toISOString(),
      batch: [cause('free'), cause('held'), cause('gone')],
    });
    expect(claimed.causeIds).toEqual(['free']);
    failImprovement(paths, 'imp2', now);
    expect(states()).toEqual({ free: 'open', held: 'processing', gone: 'dismissed' });
  });

  it('returns the batch on failure, and fixed causes when the PR closes unmerged', () => {
    start();
    failImprovement(paths, 'imp1', now);
    expect(states()).toMatchObject({ fix: 'open', drop: 'open' });
    expect(readImprovementRecords(paths.records)[0]).toMatchObject({ state: 'failed' });

    atomicWriteJsonSync(paths.records, []);
    start();
    finishImprovement(paths, 'imp1', { now, pr: { number: 8 }, decisions: { clusters: [{ id: 'a', causes: ['fix'], decision: 'fixed', reason: 'Done.' }] } });
    closeImprovement(paths, 'imp1', now);
    expect(states()).toMatchObject({ fix: 'open' });
  });

  it('records the merge commit, and treats the harness queue escalation as a return', () => {
    start();
    finishImprovement(paths, 'imp1', { now, pr: { number: 9 }, decisions: { clusters: [] } });
    expect(mergeImprovement(paths, 'imp1', { commit: 'abc123', at: now })).toMatchObject({ state: 'merged', mergeCommit: 'abc123' });

    const harnessPaths = { queue: paths.harnessQueue!, records: join(root, 'harness-improvements.json') };
    atomicWriteJsonSync(harnessPaths.queue, [cause('h1')]);
    expect(startImprovement(harnessPaths, { id: 'h', projectId: 'cezar', startedBy: 'owner', startedAt: now.toISOString(), batch: [cause('h1')] }).queue).toBe('harness');
    finishImprovement(harnessPaths, 'h', { now, decisions: { clusters: [{ id: 'x', causes: ['h1'], decision: 'escalated', reason: 'Nowhere higher.' }] } });
    expect(states(harnessPaths.queue)).toEqual({ h1: 'open' });
  });

  it('reads a decisions file or says why it is unusable', () => {
    const file = join(root, 'decisions.json');
    expect(readImprovementDecisions(file)).toEqual({ error: 'the run wrote no decisions file' });
    writeFileSync(file, '{');
    expect(readImprovementDecisions(file)).toEqual({ error: 'the decisions file is not valid JSON' });
    writeFileSync(file, JSON.stringify({ clusters: [{ id: 'a', causes: [], decision: 'fixed', reason: 'x' }] }));
    expect(readImprovementDecisions(file)).toMatchObject({ error: expect.stringContaining('invalid') });
    writeFileSync(file, JSON.stringify({ clusters: [{ id: 'a', causes: ['c'], decision: 'fixed', reason: 'x' }] }));
    expect(readImprovementDecisions(file)).toMatchObject({ decisions: { clusters: [{ id: 'a' }] } });
  });
});
