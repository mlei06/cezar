# Azure Repos on the forge seam — a stepping stone for #1617

> Slug: `azure-repos-forge-driver` · Status: **draft, proposed in #1617** · Issue: #1617 (code-host half), #1085 (not
> covered) · Follows: `2026-10-22-integration-azure-devops.md` (spec PR #1613) wherever it applies.

## TLDR

A repository whose remote is on Azure DevOps Services gets no forge today: no PR list, no Create PR, no PR chips, no
merge, no manager PR snapshot. This adds an **Azure Repos driver behind the existing `ForgeDriver` seam**, so those
surfaces work for `dev.azure.com` / `*.visualstudio.com` remotes with zero configuration, and routes the two workflow
nodes that called `gh` directly (`github.draft-pr`, `github.wait-ci`) through the forge for non-GitHub hosts.

It deliberately does **not** build the umbrella integration seam (#1614). The transport, URL builders, auth chain and
field mapping are separate modules with no dependency on `ForgeDriver`, written to the facet tables of the
Azure DevOps provider spec, so they move into `integrations/azure-devops/` when the seam lands.

## Why now, and why on the current seam

#1617 is blocked on #1614, whose spec PR is still open. Teams whose code must stay on Azure DevOps cannot use the
review gate, Create PR or managers' merge proposals at all in the meantime. The current seam already isolates
everything the code-host role needs (`resolveForge` → one driver), so a second driver is the smallest change that makes
the zero-config path work for them.

## Scope

In:

- Discovery from the git remote: `https://[user@]dev.azure.com/{org}/{project}/_git/{repo}`,
  `git@ssh.dev.azure.com:v3/{org}/{project}/{repo}`, `https://{org}.visualstudio.com/[DefaultCollection/]{project}/_git/{repo}`
  and `{org}@vs-ssh.visualstudio.com:v3/{org}/{project}/{repo}`. Project and repo names are URL-decoded.
- `ForgeKind` gains `'azure-devops'`; health's and the project registry's `forge.kind` widen to the two-value enum.
- The driver: `detect`/`detectCached`, `listPRs`, `searchItems('pr')`, `createPR`, `prStatus`, `prMergeState`,
  `mergePR`, `viewUrl`. `listIssues` answers `[]` and `searchItems('issue')` answers *not supported* (Boards is out).
- One PR-URL parser for every place that read `/pull/<n>`: `/pullrequest/<n>` is the Azure form.
- `github.draft-pr` and `github.wait-ci` use the resolved forge when it is not GitHub (`createPR`, `prMergeState`).

Out: Azure Boards work items, ADO automations (#1085), Azure DevOps Server, comments/threads, `prDiff`, fork PRs,
the GitHub-only `/github/*` routes that shell `gh` directly (they keep answering `available: false` for this host).

## Decisions

| # | Question | Decision |
|---|---|---|
| D1 | Auth, with zero config | In order: `AZURE_DEVOPS_EXT_PAT` (the variable `az devops` itself reads), then **the credential git already uses for this remote** (`git credential fill`, never interactive), then `az account get-access-token --resource 499b84ac-…` (Entra, as the provider spec's `cli` mode). Held in memory only, never written, never put in an agent's environment. A 401 drops the cached credential and retries once. |
| D2 | Why git's credential | An HTTPS Azure remote that the user already clones and pushes has a working credential in their helper (Git Credential Manager on Windows/WSL, a PAT store elsewhere). Reading it is "discover it, don't configure it"; the provider spec's PAT-in-Settings form remains the umbrella's job. |
| D3 | Transport | `fetch` with a 20 s deadline, a 4 MB body cap and `redirect: 'error'`; `api-version=7.1`; every path segment `encodeURIComponent`ed in one URL builder. Never throws: every failure is `{ ok: false, status, reason }`. |
| D4 | Merge mapping | As the provider spec's merge facet: `mergeStatus` → `mergeable`; reviewer votes and required-reviewer evaluations → `reviewDecision`; blocking policy evaluations not `approved` → blockers; `canOverride: false` (never `bypassPolicy`). Completion PATCHes `status: completed` with `lastMergeSourceCommit` = the expected head, then re-reads up to 5 times over ~10 s. |
| D5 | Merge methods | `merge` → `noFastForward`, `squash` → `squash`, `rebase` → `rebase`. Without a merge-strategy policy all three are offered and `merge` is the default: squashing an upstream merge into a fork loses the history the next merge needs. |
| D6 | Checks | Blocking build-policy evaluations plus PR statuses, one row each; `checksTier: 'detailed'`. A PR with neither has `checks: []` and `checks: null` in `prStatus`, as on GitHub with no CI. |
| D7 | Search | Azure Repos has no PR title search: a numeric query is a direct lookup, any other query filters the newest 100 PRs in any state and reports `truncated`. |
| D8 | Dry run | `CEZ_DRY_RUN=1` never authenticates or calls the network: `createPR` returns a fake `/pullrequest/777` URL, reads answer `available: false` with a dry-run reason. |

## Modules

- `server/forge/azure/remote.ts` — `parseAzureRemote`, `azureWebRoot`.
- `server/forge/azure/auth.ts` — the D1 chain, in-memory cache, `invalidate()`.
- `server/forge/azure/transport.ts` — D3; the only place a URL is built.
- `server/forge/azure/map.ts` — PR → `ForgeItem`, `ForgePrStatus`, `ForgePrMergeState` (pure functions, fixture-tested).
- `server/forge/azure.ts` — `createAzureDriver`, composing the four.
- `server/forge/pr-url.ts` — `prNumberOfUrl` for both URL forms.

## Tests

Remote parsing for every URL form (and the non-Azure hosts it must refuse); the auth chain's order, caching, the 401
retry and that nothing is ever read in dry run; mapping fixtures for open/draft/completed/abandoned PRs, policy
evaluations and statuses; `mergePR` for a moved head (409), a rejected policy, async completion; `resolveForge`
picking the driver; `prNumberOfUrl` on both forms; the contract parity suites with the widened enum.

## Acceptance

On an Azure DevOps Services repository with no setup beyond a working `git push`: the project shows its forge as
Azure DevOps, the PR list shows open PRs, Create PR opens a draft PR from a task, the task's PR chip shows its status,
a manager's merge proposal completes the PR as a merge commit, and a graph workflow's `github.draft-pr` →
`github.wait-ci` → end succeeds on it.
