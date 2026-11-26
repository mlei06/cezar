import { runBudgetUsd, type RunBudgetThreshold } from '@open-mercato/cezar-contract';
import { isTerminalStatus } from '../dispatch/engine.ts';
import { measuredRunInputTokens } from '../runs/task-metrics.ts';
import type { RunRecord } from '../runs/store.ts';

export function budgetAction(run: RunRecord): 'park' | 'notify' {
  return run.onBudget ?? (run.dispatch?.parentRunId || run.dispatch?.budgetUsd !== undefined ? 'park' : 'notify');
}

/** A crossing is durable and keyed by the ceiling in effect when it happened. */
export function checkTaskBudget(run: RunRecord, activeMs: number, at: string) {
  const park = budgetAction(run) === 'park';
  const multiples: RunBudgetThreshold['multiple'][] = park ? [1] : [1, 2, 4];
  const inputTokens = measuredRunInputTokens(run) ?? 0;
  const measurements = [
    ['usd', runBudgetUsd(run), run.costUsd ?? 0],
    ['tokens', run.budget?.tokens, inputTokens],
    ['minutes', run.budget?.minutes, activeMs / 60_000],
  ] as const;
  const crossed: RunBudgetThreshold[] = [];
  let over = false;
  for (const [metric, limit, value] of measurements) {
    if (limit === undefined || value < limit) continue;
    over = true;
    for (const multiple of multiples) {
      if (value < limit * multiple || run.budgetExceeded?.some((entry) =>
        entry.metric === metric && entry.limit === limit && entry.multiple === multiple)) continue;
      crossed.push({ metric, limit, value, multiple, at });
    }
  }
  return { park: park && over, crossed };
}

/** Reserve a share of each work ceiling without consuming the other child slots. */
export function carveChildWorkBudget(
  parent: RunRecord,
  children: readonly RunRecord[],
  freeSlots: number,
  parentActiveMs: number,
  requested: RunRecord['budget'],
): { tokens?: number; minutes?: number } | { refused: string } {
  const budget: { tokens?: number; minutes?: number } = {};
  for (const metric of ['tokens', 'minutes'] as const) {
    const limit = parent.budget?.[metric];
    const explicit = requested?.[metric];
    if (limit === undefined) {
      if (explicit !== undefined) budget[metric] = explicit;
      continue;
    }
    const usage = metric === 'tokens' ? measuredRunInputTokens(parent) ?? 0 : parentActiveMs / 60_000;
    const reserved = children.reduce((sum, child) => {
      const actual = metric === 'tokens' ? measuredRunInputTokens(child) : child.activeMs === undefined ? undefined : child.activeMs / 60_000;
      const ceiling = child.budget?.[metric] ?? 0;
      const consumed = actual ?? (child.startedAt ? ceiling : 0);
      return sum + (isTerminalStatus(child.status) ? consumed : Math.max(actual ?? 0, ceiling));
    }, 0);
    const remaining = limit - usage - reserved;
    const available = metric === 'tokens' ? Math.floor(remaining) : remaining;
    if (available <= 0) return { refused: `no ${metric} budget left after parent usage and child reservations.` };
    if (explicit !== undefined && explicit > available) {
      return { refused: `the requested ${metric} ceiling exceeds the parent's remaining budget.` };
    }
    budget[metric] = explicit ?? (metric === 'tokens' ? Math.max(1, Math.floor(available / freeSlots)) : available / freeSlots);
  }
  return budget;
}
