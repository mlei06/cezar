import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { taskScoreEntrySchema, type TaskScoreEntry } from '@open-mercato/cezar-contract';
import { atomicWriteJsonSync } from '../workspace/config.ts';

function scorePath(dataDir: string, runId: string): string {
  if (!runId || basename(runId) !== runId) throw new Error('Invalid run ID.');
  return join(dataDir, 'runs', `${runId}.scores.json`);
}

function readEntries(path: string): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

export function readRunScores(dataDir: string, runId: string): Record<string, TaskScoreEntry> {
  return Object.fromEntries(Object.entries(readEntries(scorePath(dataDir, runId))).flatMap(([name, value]) => {
    const parsed = taskScoreEntrySchema.safeParse(value);
    return parsed.success ? [[name, parsed.data]] : [];
  }));
}

/** Re-scoring one rubric keeps every other rubric's result and its pending retries. */
export function writeRunScore(dataDir: string, runId: string, name: string, value: TaskScoreEntry): void {
  const path = scorePath(dataDir, runId);
  atomicWriteJsonSync(path, { ...readEntries(path), [name]: value });
}
