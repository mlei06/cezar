import type { CauseQueueCounts, GroupVariant, ScoreGroup, ScoresQuery, ScoresResponse } from '@open-mercato/cezar-contract';
import { projectCauseQueuePath, readCauseQueue } from '../factory/causes.ts';
import type { RunRecord } from '../runs/store.ts';
import { readRunScores } from './store.ts';

export function aggregateScores(dataDir: string, runs: readonly RunRecord[], query: ScoresQuery): ScoresResponse {
  const since = query.since?.endsWith('d')
    ? Date.now() - Number(query.since.slice(0, -1)) * 86_400_000
    : query.since ? Date.parse(query.since) : 0;
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
  const sorted = [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
  try {
    const causes = readCauseQueue(projectCauseQueuePath(dataDir));
    const counts: CauseQueueCounts = {};
    for (const cause of causes) counts[cause.state] = (counts[cause.state] ?? 0) + 1;
    const openCauses = causes.filter((cause) => cause.state === 'open').slice(0, 20);
    return { groups: sorted, queue: { counts, openCauses } };
  } catch {
    return { groups: sorted, queue: null };
  }
}


export function groupScoreColumns(dataDir: string, run: RunRecord): NonNullable<GroupVariant['scores']> {
  if (!run.finishedAt) return [];
  try {
    return Object.entries(readRunScores(dataDir, run.id)).flatMap(([scorer, entry]) => {
      if (entry.status !== 'scored' || entry.finishedAt !== run.finishedAt) return [];
      return [{ scorer, label: entry.score.label, pass: entry.score.pass }];
    });
  } catch {
    return [];
  }
}
