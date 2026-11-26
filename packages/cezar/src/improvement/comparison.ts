import { join } from 'node:path';
import type { HarnessVersion, ImprovementComparison, ImprovementRecord, QueuedCause } from '@open-mercato/cezar-contract';
import { projectCauseQueuePath, readCauseQueue } from '../factory/causes.ts';
import type { RunRecord } from '../runs/store.ts';
import { groupScoreColumns } from '../scoring/summary.ts';
import { projectImprovementRecordsPath, readImprovementRecords } from './bookkeeping.ts';
import type { ImprovementSettings } from './settings.ts';

const DAY = 86_400_000;
const MAX_COMPARISON_RUNS = 50;
const DIGEST_EXAMPLES = 5;

export interface ImprovementRunHistory {
  dataDir: string;
  runs: readonly RunRecord[];
}

type ScoredRun = {
  at: number;
  scores: ReturnType<typeof groupScoreColumns>;
  costUsd?: number;
  harnessVersion?: HarnessVersion;
};

function scoredRuns(history: readonly ImprovementRunHistory[]): ScoredRun[] {
  return history.flatMap(({ dataDir, runs }) => runs.flatMap((run): ScoredRun[] => {
    if (run.replayOf || !run.finishedAt) return [];
    const at = Date.parse(run.finishedAt);
    if (!Number.isFinite(at)) return [];
    const scores = groupScoreColumns(dataDir, run);
    return scores.length ? [{ at, scores, costUsd: run.costUsd, harnessVersion: run.harnessVersion }] : [];
  }));
}

function aggregate(runs: readonly ScoredRun[]): ImprovementComparison['before'] {
  const groups = new Map<string, { passed: number; failed: number; costSamples: number; cost: number }>();
  for (const { scores, costUsd } of runs) {
    for (const { scorer, pass } of scores) {
      const group = groups.get(scorer) ?? { passed: 0, failed: 0, costSamples: 0, cost: 0 };
      if (pass) group.passed++; else group.failed++;
      if (costUsd !== undefined) {
        group.costSamples++;
        group.cost += costUsd;
      }
      groups.set(scorer, group);
    }
  }
  return Array.from(groups, ([scorer, { cost, ...group }]) => ({
    scorer, ...group, ...(group.costSamples ? { meanCostUsd: cost / group.costSamples } : {}),
  })).sort((a, b) => a.scorer.localeCompare(b.scorer));
}

export function compareImprovement(input: {
  record: ImprovementRecord;
  history: readonly ImprovementRunHistory[];
  cooldown: Pick<ImprovementSettings, 'cooldownDays' | 'cooldownRuns'>;
  now: Date;
  /** Caller verifies this active release contains the improvement's exact merged commit. */
  afterRelease?: HarnessVersion;
}): ImprovementComparison | undefined {
  const { record, cooldown, now, afterRelease } = input;
  if (record.state !== 'merged' || !record.mergedAt || record.comparison || (record.queue === 'harness' && !afterRelease)) return;
  const boundary = Date.parse(record.mergedAt);
  const samples = scoredRuns(input.history).sort((a, b) => a.at - b.at);
  const before = samples.filter(({ at }) => at < boundary);
  const after = samples.filter(({ at, harnessVersion }) => at > boundary && at <= now.getTime() &&
    (!afterRelease || (harnessVersion?.id === afterRelease.id && harnessVersion?.commit === afterRelease.commit)));
  const daysElapsed = cooldown.cooldownDays !== undefined && now.getTime() - boundary >= cooldown.cooldownDays * DAY;
  if (!before.length || !after.length || (after.length < cooldown.cooldownRuns && !daysElapsed)) return;
  const sampleSize = Math.min(MAX_COMPARISON_RUNS, before.length, after.length);
  const previous = aggregate(before.slice(-sampleSize));
  const current = aggregate(after.slice(0, sampleSize));
  const regressed = current.some(({ scorer, passed, failed }) => {
    const baseline = previous.find((row) => row.scorer === scorer);
    return baseline && passed * (baseline.passed + baseline.failed) < baseline.passed * (passed + failed);
  });
  return {
    measuredAt: now.toISOString(), before: previous, after: current, beforeRuns: sampleSize, afterRuns: sampleSize, regressed,
    ...(afterRelease ? { harnessVersion: afterRelease } : {}),
  };
}

export function harnessCauseDigest(projects: readonly { id: string; root: string }[], harnessId: string, now: Date) {
  const evidence = ({ scorer, label, cause }: QueuedCause) => ({ scorer, label, ...cause });
  type Digest = { project: string; unavailable: true } | {
    project: string;
    openCount: number;
    recentProcessedCount: number;
    open: ReturnType<typeof evidence>[];
    recentlyProcessed: ReturnType<typeof evidence>[];
  };
  return projects.flatMap<Digest>(({ id, root }) => {
    if (id === harnessId) return [];
    const dataDir = join(root, '.ai/cezar');
    try {
      const causes = readCauseQueue(projectCauseQueuePath(dataDir));
      const recent = new Set(readImprovementRecords(projectImprovementRecordsPath(dataDir)).flatMap((record) => {
        const at = Date.parse(record.mergedAt ?? record.finishedAt ?? '');
        return at >= now.getTime() - 30 * DAY
          ? record.clusters?.flatMap((cluster) => cluster.decision === 'fixed' ? cluster.causes : []) ?? [] : [];
      }));
      const open = causes.filter(({ state }) => state === 'open');
      const processed = causes.filter((cause) => cause.state === 'processed' && recent.has(cause.id));
      return [{
        project: id, openCount: open.length, recentProcessedCount: processed.length,
        open: open.slice(0, DIGEST_EXAMPLES).map(evidence),
        recentlyProcessed: processed.slice(-DIGEST_EXAMPLES).map(evidence),
      }];
    } catch {
      return [{ project: id, unavailable: true }];
    }
  });
}
