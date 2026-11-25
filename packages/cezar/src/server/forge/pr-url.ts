/**
 * Pull-request web URLs on every supported forge: GitHub's `/{owner}/{repo}/pull/<n>` and Azure Repos'
 * `/{org}/{project}/_git/{repo}/pullrequest/<n>` (spec 2026-11-24-azure-repos-forge-driver).
 */

/** A PR URL anywhere in free text (any host: GitHub Enterprise lives on arbitrary domains). */
export const PR_URL_RE =
  /https:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/pull\/\d+|https:\/\/[^/\s]+(?:\/[^/\s]+){1,3}\/_git\/[^/\s]+\/pullrequest\/\d+/i;

const PR_PATH = /\/(?:pull|pullrequest)\/(\d+)(?=$|[/?#])/i;

/** The PR number a web URL names, or undefined. */
export function prNumberOfUrl(url: string | undefined | null): number | undefined {
  const n = url ? PR_PATH.exec(url)?.[1] : undefined;
  return n ? Number(n) : undefined;
}
