import { checksGlyph } from './azure/map.ts';
import { azureDriverFor } from './azure-routes.ts';
// Through `pr.ts`, as every caller did before, so tests that mock it keep doing so.
import { createDraftPr } from '../pr.ts';
import { fetchPrHeadChecks, type HeadChecksVerdict } from './github.ts';
import { prNumberOfUrl } from './pr-url.ts';
import type { DraftPrInput, DraftPrOutcome } from './types.ts';

/**
 * A task's own PR on whichever forge its repository is on (spec 2026-11-24-azure-repos-forge-driver): the run
 * header's Create PR and the `github.draft-pr` / `github.wait-ci` workflow nodes. GitHub keeps its existing code
 * paths unchanged; an Azure Repos remote goes through the Azure driver.
 */


export async function createTaskPr(input: DraftPrInput): Promise<DraftPrOutcome> {
  const azure = await azureDriverFor(input.repoRoot);
  return azure ? azure.createPR(input) : createDraftPr(input);
}

/** The CI verdict for one exact commit of the task's PR (#1533's contract, on either forge). */
export async function taskPrHeadChecks(repoRoot: string, number: number, sha: string): Promise<HeadChecksVerdict> {
  const azure = await azureDriverFor(repoRoot);
  if (!azure) return fetchPrHeadChecks(repoRoot, number, sha);
  const result = await azure.prMergeState!(number, { refresh: true });
  if (!result.available) return { kind: 'unavailable' };
  const state = result.mergeState;
  if (state.headSha && state.headSha.toLowerCase() !== sha.toLowerCase()) return { kind: 'stale', headOid: state.headSha };
  if (state.mergeable === 'conflicting') return { kind: 'conflict' };
  return { kind: 'checks', glyph: checksGlyph(state.checks) };
}

/** Mark an Azure Repos draft PR ready; null when the repository is not on Azure (the caller keeps its own path). */
export async function markAzurePrReady(repoRoot: string, url: string, branch?: string): Promise<{ ok: true } | { ok: false; error: string } | null> {
  const azure = await azureDriverFor(repoRoot);
  if (!azure) return null;
  const number = prNumberOfUrl(url);
  if (!number) return { ok: false, error: 'not a pull request URL' };
  if (!branch) return { ok: false, error: 'no task branch to verify' };
  return azure.markPrReady(number, branch);
}
