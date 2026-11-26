import type { ImprovementRecord, QueuedCause } from '@open-mercato/cezar-contract';
import type { ImprovementSettings } from './settings.ts';

/** At most this many causes go into one improvement run's brief. */
export const MAX_BATCH = 50;
/** Automatic starts pause after this many consecutive failed improvement runs. */
export const FAILURE_PAUSE = 3;

export type TriggerResult =
  | { fire: true; batch: QueuedCause[] }
  | { fire: false; reason: string };

const DAY_MS = 86_400_000;

/**
 * Whether a queue should start an improvement run now (spec D6). No model call: the hourly
 * `factory` event source and the manual starts both ask this. A manual start skips the
 * threshold and the failure pause, never the one-at-a-time guard or the cooldown.
 */
export function evaluateImprovementTrigger(input: {
  queue: readonly QueuedCause[];
  records: readonly ImprovementRecord[];
  settings: ImprovementSettings;
  /** Scored runs in this queue's scope since the last merged improvement. */
  scoredRunsSinceMerge: number;
  now: Date;
  manual?: boolean;
}): TriggerResult {
  const { settings, records, now } = input;
  if (!settings.enabled) return { fire: false, reason: 'self-improvement is turned off' };

  const inFlight = records.find((record) => record.state === 'running' || record.state === 'pr-open');
  if (inFlight) {
    return { fire: false, reason: inFlight.state === 'running'
      ? `improvement run ${inFlight.id} is still running`
      : `improvement PR from ${inFlight.id} is still open` };
  }

  const lastMerge = records
    .filter((record) => record.state === 'merged' && record.mergedAt)
    .sort((a, b) => (a.mergedAt! < b.mergedAt! ? 1 : -1))[0];
  if (lastMerge?.mergedAt) {
    const runsDone = input.scoredRunsSinceMerge >= settings.cooldownRuns;
    const daysDone = settings.cooldownDays !== undefined &&
      now.getTime() - Date.parse(lastMerge.mergedAt) >= settings.cooldownDays * DAY_MS;
    if (!runsDone && !daysDone) {
      const left = settings.cooldownRuns - input.scoredRunsSinceMerge;
      return { fire: false, reason: settings.cooldownDays === undefined
        ? `cooldown: ${left} more scored runs after the last merged improvement`
        : `cooldown: ${left} more scored runs or ${settings.cooldownDays} days after the last merged improvement` };
    }
  }

  const open = input.queue.filter((cause) => cause.state === 'open').sort((a, b) => (a.at < b.at ? -1 : 1));
  if (open.length === 0) return { fire: false, reason: 'no open causes' };

  if (!input.manual) {
    const recent = [...records].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)).slice(0, FAILURE_PAUSE);
    if (recent.length === FAILURE_PAUSE && recent.every((record) => record.state === 'failed')) {
      return { fire: false, reason: `paused after ${FAILURE_PAUSE} failed improvement runs; start one manually to resume` };
    }
    const oldestAgeDays = (now.getTime() - Date.parse(open[0]!.at)) / DAY_MS;
    const byCount = open.length >= settings.threshold;
    const byAge = oldestAgeDays >= settings.ageDays && open.length >= settings.minForAge;
    if (!byCount && !byAge) {
      return { fire: false, reason: `${open.length} open causes, below the threshold of ${settings.threshold}` };
    }
  }
  return { fire: true, batch: open.slice(0, MAX_BATCH) };
}
