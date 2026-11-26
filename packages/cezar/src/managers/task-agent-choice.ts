/**
 * Which agent account a manager's new task runs on. The manager's allowed task accounts are the
 * default, in order; an account waiting out a usage limit is skipped for the next with capacity.
 * Limit state is the workspace's account holds — the same the queue enforces — never a second source.
 */
import type { RunnerId } from '../core/agent-runner.ts';
import type { LedgerAccountRef } from '../usage-ledger/recorder.ts';
import type { LedgerRecord } from '../usage-ledger/store.ts';

export interface AccountOption {
  runner: RunnerId;
  /** Absent: the project's automatic account. */
  agentProfile?: string;
  /** The resolved account id the limit is keyed on. */
  account: string;
  label: string;
  /** Epoch ms the account's usage limit resets; absent = capacity now. */
  until?: number;
}

export interface TaskAgentChoice<T extends AccountOption = AccountOption> {
  chosen: T;
  reason: string;
  /** Every candidate is out of limits: the task waits in the queue until this instant. */
  queuedUntil?: number;
  /** An explicit account that is out of limits while an allowed one has capacity. */
  warning?: string;
}

const iso = (ms: number) => new Date(ms).toISOString();
export const accountName = (option: Pick<AccountOption, 'runner' | 'label'>) => `${option.runner} ${option.label}`;
export const accountFlags = (option: Pick<AccountOption, 'runner' | 'agentProfile'>) =>
  `--runner ${option.runner}${option.agentProfile ? ` --account ${option.agentProfile}` : ''}`;

/**
 * `candidates` are ordered, preferred first, and already narrowed by explicit flags; `allowed` is
 * every account the manager may use, for naming an alternative to an explicit pick. Never empty.
 */
export function chooseTaskAgent<T extends AccountOption>(
  candidates: readonly T[],
  options: {
    explicitAccount: boolean; fromSettings: boolean; allowed?: readonly AccountOption[]; now: number;
    /** The flag that narrowed `candidates` below `allowed` (e.g. `--runner codex`), for honest wording. */
    narrowedBy?: string;
  },
): TaskAgentChoice<T> {
  const open = (option: AccountOption) => option.until === undefined || option.until <= options.now;
  const first = candidates[0];
  if (!first) throw new Error('chooseTaskAgent needs at least one candidate');
  if (options.explicitAccount) {
    if (open(first)) return { chosen: first, reason: 'explicit --account' };
    const alternative = (options.allowed ?? candidates).find((option) => open(option));
    return {
      chosen: first,
      reason: `explicit --account; ${accountName(first)} is out of limits until ${iso(first.until!)}, so the task waits in the queue`,
      queuedUntil: first.until,
      ...(alternative ? { warning: `${accountName(first)} is out of usage limits until ${iso(first.until!)}; ${accountName(alternative)} has capacity (${accountFlags(alternative)})` } : {}),
    };
  }
  const source = options.fromSettings ? 'default from manager settings' : 'automatic selection';
  const available = candidates.find(open);
  const skipped = candidates.slice(0, available ? candidates.indexOf(available) : candidates.length);
  const skippedText = skipped.map((option) => `${accountName(option)} out of limits until ${iso(option.until!)}`).join('; ');
  if (available) {
    return { chosen: available, reason: skipped.length ? `${source}: ${skippedText}, used ${accountName(available)}` : `${source}: ${accountName(available)}` };
  }
  const soonest = candidates.reduce((best, option) => (option.until! < best.until! ? option : best));
  // A flag narrowed the choice: "every allowed account" is only true of the accounts it left.
  const alternative = options.narrowedBy ? options.allowed?.find(open) : undefined;
  const scope = options.narrowedBy ? `every allowed account for ${options.narrowedBy}` : 'every allowed account';
  return {
    chosen: soonest,
    reason: candidates.length === 1
      ? `${source}: ${skippedText}; the task waits in the queue until it resets`
      : `${source}: ${scope} is out of limits (${skippedText}); queued on ${accountName(soonest)}, the first to reset`,
    queuedUntil: soonest.until,
    ...(alternative ? { warning: `${options.narrowedBy} has no account with capacity until ${iso(soonest.until!)}; ${accountName(alternative)} has capacity (${accountFlags(alternative)})` } : {}),
  };
}

/** Fresh account-wide readings can route new ordinary tasks before the account is held. */
export function accountUsageAbove(
  records: readonly LedgerRecord[], account: LedgerAccountRef, now: number, threshold = 0.8,
): boolean {
  type Reading = Extract<LedgerRecord, { t: 'reading' }>;
  const latest = new Map<Reading['window'], Reading>();
  for (const entry of records) {
    if (entry.t !== 'reading' || entry.account !== account.key || entry.identity !== account.identity ||
      entry.at > now || now - entry.at > 30 * 60_000) continue;
    if (entry.at >= (latest.get(entry.window)?.at ?? 0)) latest.set(entry.window, entry);
  }
  return [...latest.values()].some((entry) => entry.resetsAt > now && entry.usedPercent > threshold * 100);
}
