import type { GithubChecksData, GithubData, GithubRefStatusData } from '@open-mercato/cezar-contract';
import { getRepoInfo } from '../git.ts';
import { createAzureDriver, type AzureForgeDriver } from './azure.ts';
import { checksGlyph } from './azure/map.ts';
import { parseAzureRemote } from './azure/remote.ts';
import type { ForgeCommentsData, ForgePrDiffResult, ForgePrMergeState, ForgeSearchData } from './types.ts';

/**
 * The `/github/*` read routes for a project whose remote is on Azure DevOps Services (spec
 * 2026-11-24-azure-repos-forge-driver). Those routes call `gh` directly, which would answer for any GitHub remote the
 * repository also has (an `upstream`, say) instead of the project's own forge. Same response shapes, so the cockpit
 * needs no second code path; what Azure Repos cannot answer here degrades in the payload, never as an error.
 */

const drivers = new Map<string, AzureForgeDriver>();
const REF_STATUS_MAX = 20;
const RECHECK_MS = 60_000;

/** The project's Azure driver, or null when its remote is not on Azure DevOps Services. One per remote. */
export async function azureDriverFor(root: string): Promise<AzureForgeDriver | null> {
  const remote = (await getRepoInfo(root))?.remote;
  const azure = parseAzureRemote(remote);
  if (!azure) return null;
  const key = `${azure.org}/${azure.project}/${azure.repo}`;
  let driver = drivers.get(key);
  if (!driver) drivers.set(key, (driver = createAzureDriver(azure)));
  return driver;
}

export async function azureGithubData(driver: AzureForgeDriver, refresh: boolean, limit: number): Promise<GithubData> {
  const availability = await driver.detect();
  if (!availability.available) return { available: false, reason: availability.reason, issues: [], prs: [] };
  const prs = await driver.listPRs({ refresh, limit });
  return { available: true, issues: [], prs, syncedAt: new Date().toISOString(), issuesTotal: 0, prsTotal: prs.length };
}

export function azureSearch(driver: AzureForgeDriver, kind: 'issue' | 'pr', q: string, limit?: number): Promise<ForgeSearchData> {
  return driver.searchItems!(kind, q, limit ? { limit } : {});
}

export async function azureChecks(driver: AzureForgeDriver, numbers: number[]): Promise<GithubChecksData> {
  const checks: Record<number, ReturnType<typeof checksGlyph>> = {};
  for (const n of numbers) {
    const result = await driver.prMergeState!(n);
    if (!result.available) return { available: false, reason: result.reason };
    checks[n] = checksGlyph(result.mergeState.checks);
  }
  return { available: true, checks };
}

/** One PR's chip word, in the vocabulary `/github/ref-status` answers with. @internal */
export function refStatusOf(state: ForgePrMergeState) {
  if (state.state === 'merged') return 'merged' as const;
  if (state.state === 'closed') return 'closed' as const;
  if (state.isDraft) return 'draft' as const;
  if (state.reviewDecision === 'changes-requested') return 'changes-requested' as const;
  const glyph = checksGlyph(state.checks);
  if (glyph === 'failing') return 'checks-failing' as const;
  if (glyph === 'pending') return 'checks-pending' as const;
  if (state.reviewDecision === 'review-required') return 'review-required' as const;
  return 'ready' as const;
}

export async function azureRefStatus(driver: AzureForgeDriver, numbers: number[]): Promise<GithubRefStatusData> {
  const prs: Record<number, ReturnType<typeof refStatusOf>> = {};
  const conflicts: number[] = [];
  let open = false;
  for (const n of numbers.slice(0, REF_STATUS_MAX)) {
    const result = await driver.prMergeState!(n);
    if (!result.available) {
      // A PR another forge holds is not an error for the batch: it stays absent ("nothing known").
      if (Object.keys(prs).length === 0 && n === numbers[0]) return { available: false, reason: result.reason, recheckAfterMs: RECHECK_MS };
      continue;
    }
    const state = result.mergeState;
    prs[n] = refStatusOf(state);
    if (state.state === 'open') {
      open = true;
      if (state.mergeable === 'conflicting') conflicts.push(n);
    }
  }
  // Boards work items are out of scope: issue numbers stay absent.
  return { available: true, prs, issues: {}, conflicts, recheckAfterMs: open || numbers.length > REF_STATUS_MAX ? RECHECK_MS : null };
}

export const azureComments = (): ForgeCommentsData => ({
  available: false,
  reason: 'comment threads on Azure DevOps are not shown yet',
  comments: [],
});

export const azurePrChanges = (): ForgePrDiffResult => ({
  available: false,
  reason: 'file changes of an Azure DevOps pull request are not shown yet — open it on Azure DevOps',
});
