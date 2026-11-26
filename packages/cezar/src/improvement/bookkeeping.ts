import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  improvementDecisionsSchema, improvementRecordsSchema,
  type ImprovementDecisions, type ImprovementRecord, type QueuedCause,
} from '@open-mercato/cezar-contract';
import { readCauseQueue } from '../factory/causes.ts';
import { cezarHomeDir } from '../paths.ts';
import { atomicWriteJsonSync } from '../workspace/config.ts';

/** Where an improvement run's queue and records live (spec "Data model": improvements.json). */
export interface ImprovementPaths {
  queue: string;
  records: string;
  /** The harness queue, which receives escalated causes. Absent when this IS the harness queue. */
  harnessQueue?: string;
}

export function projectImprovementRecordsPath(dataDir: string): string {
  return join(dataDir, 'factory', 'improvements.json');
}

export function harnessImprovementRecordsPath(): string {
  return join(cezarHomeDir(), 'factory', 'harness-improvements.json');
}

export function readImprovementRecords(path: string): ImprovementRecord[] {
  try {
    return improvementRecordsSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** The decisions file a finished run wrote, or why it can't be used. */
export function readImprovementDecisions(path: string): { decisions: ImprovementDecisions } | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return { error: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'the run wrote no decisions file' : 'the decisions file is not valid JSON' };
  }
  const parsed = improvementDecisionsSchema.safeParse(raw);
  return parsed.success ? { decisions: parsed.data } : { error: `the decisions file is invalid: ${parsed.error.issues[0]?.message ?? 'unknown issue'}` };
}

function setStates(path: string, ids: ReadonlySet<string>, state: (cause: QueuedCause) => QueuedCause['state']): QueuedCause[] {
  const queue = readCauseQueue(path);
  const touched: QueuedCause[] = [];
  const next = queue.map((cause) => {
    if (!ids.has(cause.id)) return cause;
    const updated = { ...cause, state: state(cause) };
    touched.push(updated);
    return updated;
  });
  if (touched.length) atomicWriteJsonSync(path, next);
  return touched;
}

function updateRecord(path: string, id: string, change: (record: ImprovementRecord) => ImprovementRecord): ImprovementRecord {
  const records = readImprovementRecords(path);
  const index = records.findIndex((record) => record.id === id);
  if (index < 0) throw new Error(`No improvement record ${id}.`);
  const updated = change(records[index]!);
  records[index] = updated;
  atomicWriteJsonSync(path, records);
  return updated;
}

/** Claim a batch: its causes become `processing` and a `running` record is written. */
export function startImprovement(paths: ImprovementPaths, input: {
  id: string;
  projectId: string;
  runId?: string;
  startedBy: ImprovementRecord['startedBy'];
  startedAt: string;
  batch: readonly QueuedCause[];
}): ImprovementRecord {
  const { batch, ...rest } = input;
  const wanted = new Set(batch.map((cause) => cause.id));
  // Claim only causes still open: one another run holds, or a decision already settled, stays out.
  const open = new Set(readCauseQueue(paths.queue).filter((cause) => wanted.has(cause.id) && cause.state === 'open').map((cause) => cause.id));
  setStates(paths.queue, open, () => 'processing');
  const record: ImprovementRecord = {
    ...rest, queue: paths.harnessQueue ? 'project' : 'harness', causeIds: [...open], state: 'running',
  };
  atomicWriteJsonSync(paths.records, [...readImprovementRecords(paths.records), record]);
  return record;
}

/**
 * Apply a finished run's decisions (spec D6 bookkeeping): fixed causes are processed, dismissed
 * ones dismissed, escalated ones move to the harness queue, and deferred or undecided ones
 * return to the queue. A cause outside the batch is ignored.
 */
export function finishImprovement(paths: ImprovementPaths, id: string, input: {
  decisions: ImprovementDecisions;
  pr?: ImprovementRecord['pr'];
  now: Date;
}): ImprovementRecord {
  const record = readImprovementRecords(paths.records).find((entry) => entry.id === id);
  if (!record) throw new Error(`No improvement record ${id}.`);
  const batch = new Set(record.causeIds);
  const decided = new Map<string, string>();
  for (const cluster of input.decisions.clusters) {
    for (const cause of cluster.causes) if (batch.has(cause) && !decided.has(cause)) decided.set(cause, cluster.decision);
  }
  const escalate = paths.harnessQueue !== undefined;
  const touched = setStates(paths.queue, batch, (cause) => {
    switch (decided.get(cause.id)) {
      case 'fixed': return 'processed';
      case 'dismissed': return 'dismissed';
      case 'escalated': return escalate ? 'escalated' : 'open';
      default: return 'open';
    }
  });
  if (escalate) {
    const moving = touched.filter((cause) => cause.state === 'escalated');
    if (moving.length) {
      const harness = readCauseQueue(paths.harnessQueue!);
      const present = new Set(harness.map((cause) => cause.id));
      const additions = moving.filter((cause) => !present.has(cause.id)).map((cause) => ({ ...cause, state: 'open' as const }));
      if (additions.length) atomicWriteJsonSync(paths.harnessQueue!, [...harness, ...additions]);
    }
  }
  return updateRecord(paths.records, id, (entry) => ({
    ...entry, clusters: input.decisions.clusters, finishedAt: input.now.toISOString(),
    state: input.pr ? 'pr-open' : 'closed', ...(input.pr ? { pr: input.pr } : {}),
  }));
}

/** A failed or cancelled run returns its whole batch to the queue unprocessed. */
export function failImprovement(paths: ImprovementPaths, id: string, now: Date): ImprovementRecord {
  const record = readImprovementRecords(paths.records).find((entry) => entry.id === id);
  if (!record) throw new Error(`No improvement record ${id}.`);
  setStates(paths.queue, new Set(record.causeIds), (cause) => (cause.state === 'processing' ? 'open' : cause.state));
  return updateRecord(paths.records, id, (entry) => ({ ...entry, state: 'failed', finishedAt: now.toISOString() }));
}

/** The improvement PR merged: its commit starts the before/after window and the cooldown. */
export function mergeImprovement(paths: ImprovementPaths, id: string, input: { commit: string; at: Date }): ImprovementRecord {
  return updateRecord(paths.records, id, (entry) => ({ ...entry, state: 'merged', mergeCommit: input.commit, mergedAt: input.at.toISOString() }));
}

/** The improvement PR closed unmerged: its fixes never landed, so their causes reopen. */
export function closeImprovement(paths: ImprovementPaths, id: string, now: Date): ImprovementRecord {
  const record = readImprovementRecords(paths.records).find((entry) => entry.id === id);
  if (!record) throw new Error(`No improvement record ${id}.`);
  setStates(paths.queue, new Set(record.causeIds), (cause) => (cause.state === 'processed' ? 'open' : cause.state));
  return updateRecord(paths.records, id, (entry) => ({ ...entry, state: 'closed', finishedAt: entry.finishedAt ?? now.toISOString() }));
}
