import type { ScoreGroup, ScoresQuery, ScoresResponse } from '@open-mercato/cezar-contract';
import type { RunRecord } from '../runs/store.ts';
import { readRunScores } from './store.ts';

export function aggregateScores(dataDir: string, runs: readonly RunRecord[], query: ScoresQuery): ScoresResponse {
  const since = query.since ? Date.parse(query.since) : 0;
  const groups = new Map<string, ScoreGroup>();
  const get = (key: string): ScoreGroup => {
    const prior = groups.get(key);
    if (prior) return prior;
    const group = { key, passed: 0, failed: 0, pending: 0, errors: 0 };
    groups.set(key, group);
    return group;
  };
  for (const run of runs) {
    if (!run.finishedAt || Date.parse(run.finishedAt) < since) continue;
    try {
      for (const [name, entry] of Object.entries(readRunScores(dataDir, run.id))) {
        if (entry.finishedAt !== run.finishedAt) continue;
        if (query.groupBy === 'scorer') {
          const row = get(name);
          if (entry.status === 'pending') row.pending++;
          else if (entry.status === 'error') row.errors++;
          else if (entry.score.pass) row.passed++;
          else row.failed++;
        } else if (entry.status === 'scored') {
          for (const key of new Set(entry.score.causes.map((cause) => query.groupBy === 'category' ? cause.category : cause.target))) {
            get(key).failed++;
          }
        }
      }
    } catch {
      // An unreadable score file should not hide the aggregate for every other task.
    }
  }
  return { groups: [...groups.values()].sort((a, b) => a.key.localeCompare(b.key)) };
}
