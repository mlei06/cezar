import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { causeQueueSchema, type QueuedCause, type RecordedScore } from '@open-mercato/cezar-contract';
import { cezarHomeDir } from '../paths.ts';
import { atomicWriteJsonSync } from '../workspace/config.ts';

interface CauseOrigin {
  projectId: string;
  runId: string;
  workflowSource?: 'file' | 'built-in';
  harness: boolean;
  improvement?: boolean;
  benchmark?: boolean;
}

export function routeCauses(score: RecordedScore, origin: CauseOrigin): {
  project: QueuedCause[];
  harness: QueuedCause[];
  infra: QueuedCause[];
} {
  const queues = { project: [] as QueuedCause[], harness: [] as QueuedCause[], infra: [] as QueuedCause[] };
  if (score.pass || origin.benchmark) return queues;
  for (const cause of score.causes) {
    const id = createHash('sha256').update(JSON.stringify([origin.projectId, origin.runId, score.scorer, cause])).digest('hex').slice(0, 24);
    const entry: QueuedCause = {
      id, projectId: origin.projectId, runId: origin.runId, scorer: score.scorer, label: score.label,
      reasoning: score.reasoning, cause, at: score.at, state: 'open',
    };
    const target = cause.target;
    if (target === 'infra') queues.infra.push(entry);
    else if (origin.harness || origin.improvement || target === 'harness' || target === 'manager-skill' ||
      (target === 'brief' && origin.workflowSource === 'built-in')) queues.harness.push(entry);
    else queues.project.push(entry);
  }
  return queues;
}

export function harnessCauseQueuePath(): string {
  return join(cezarHomeDir(), 'factory', 'harness-queue.json');
}

export function projectCauseQueuePath(dataDir: string): string {
  return join(dataDir, 'factory', 'queue.json');
}

export function readCauseQueue(path: string): QueuedCause[] {
  try {
    return causeQueueSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** Replace only open findings for a re-scored rubric, preserving dispositions and first-seen age. */
export function recordCauses(path: string, origin: Pick<CauseOrigin, 'projectId' | 'runId'>, scorer: string, next: QueuedCause[]): void {
  const queue = readCauseQueue(path);
  const removed = new Map<string, QueuedCause>();
  const kept = queue.filter((entry) => {
    if (entry.projectId !== origin.projectId || entry.runId !== origin.runId || entry.scorer !== scorer || entry.state !== 'open') return true;
    removed.set(entry.id, entry);
    return false;
  });
  const existing = new Set(kept.map((entry) => entry.id));
  const additions: QueuedCause[] = [];
  for (const entry of next) {
    if (existing.has(entry.id)) continue;
    existing.add(entry.id);
    additions.push({ ...entry, at: removed.get(entry.id)?.at ?? entry.at });
  }
  if (removed.size || additions.length) atomicWriteJsonSync(path, [...kept, ...additions]);
}

export function detectHarnessProject(projects: readonly { id: string; root: string }[], configured?: string): string | undefined {
  if (configured !== undefined) return projects.some(({ id }) => id === configured) ? configured : undefined;
  const matches = projects.filter(({ root }) => {
    if (existsSync(join(root, '.ai/cezar/HARNESS'))) return true;
    for (const file of ['package.json', 'packages/cezar/package.json']) {
      try {
        if (JSON.parse(readFileSync(join(root, file), 'utf8')).name === '@open-mercato/cezar') return true;
      } catch {
        // Missing or invalid manifests are not harness markers.
      }
    }
    return false;
  });
  return matches.length === 1 ? matches[0]?.id : undefined;
}
