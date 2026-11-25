import { execFile } from 'node:child_process';
import { z } from 'zod';
import { autosaveCommit, taskRemotes } from '../../git-worktree.ts';
import { splitRemoteRef } from '../../git-remotes.ts';
import { baseDivergence, rewriteLeaseArg } from '../git-changes.ts';
import { createAzureAuth, type ToolRunner } from './azure/auth.ts';
import {
  azureEvaluationSchema,
  azurePrListSchema,
  azurePrSchema,
  azureStatusSchema,
  branchOf,
  MERGE_STRATEGY,
  parseEach,
  prUrl,
  toForgeItem,
  toMergeState,
  toPrStatus,
  toChecks,
  type AzureEvaluation,
  type AzurePr,
  type AzureStatus,
} from './azure/map.ts';
import { azureProjectRoot, azureWebRoot, type AzureRemote } from './azure/remote.ts';
import { createAzureTransport, type AzureTransport, type Fetch } from './azure/transport.ts';
import { buildPrBody } from './github.ts';
import type {
  DraftPrInput,
  DraftPrOutcome,
  ForgeAvailability,
  ForgeDriver,
  ForgeItem,
  ForgeMergeInput,
  ForgeMergeResult,
  ForgePrMergeStateResult,
  ForgePrStatus,
  ForgeRefKind,
  ForgeSearchData,
} from './types.ts';

/**
 * Azure Repos (Azure DevOps Services) behind the forge seam — spec `2026-11-24-azure-repos-forge-driver`, a
 * stepping stone for #1617. Boards work items are out of scope: `listIssues` is empty and issue search says so.
 * Never throws: every failure degrades to `available: false`, `null` or an `ok: false` outcome.
 */

const DETECT_TTL_MS = 60_000;
const LIST_TTL_MS = 30_000;
const LIST_MAX = 100;
const DESCRIPTION_MAX = 4000; // Azure's PR description limit (provider spec, publish facet)
const PUSH_TIMEOUT_MS = 60_000;
const COMPLETE_REREADS = 5;
const COMPLETE_GAP_MS = 2_000;

const repoSchema = z
  .object({
    id: z.string(),
    defaultBranch: z.string().optional().catch(undefined),
    project: z.object({ id: z.string() }).passthrough(),
  })
  .passthrough();

interface RepoFacts {
  id: string;
  projectId: string;
  defaultBranch?: string;
}

export interface AzureDriverDeps {
  fetch?: Fetch;
  run?: ToolRunner;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Tests stand in their own transport. */
  transport?: AzureTransport;
}

const gitIn = (cwd: string, args: string[], timeout = 30_000) =>
  new Promise<{ ok: boolean; stderr: string }>((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } },
      (err, _stdout, stderr) => resolve({ ok: !err, stderr: stderr ?? '' }),
    );
  });

const lastLine = (s: string) => s.trim().split('\n').filter(Boolean).at(-1) ?? '';

/** The Azure driver, plus the one action the seam has no method for yet: publishing a draft PR. */
export type AzureForgeDriver = ForgeDriver & {
  markPrReady(number: number): Promise<{ ok: true } | { ok: false; error: string }>;
};

export function createAzureDriver(remote: AzureRemote, deps: AzureDriverDeps = {}): AzureForgeDriver {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const auth = createAzureAuth(remote, { run: deps.run, env, now });
  const t = deps.transport ?? createAzureTransport(remote, auth, deps.fetch);
  const webRoot = azureWebRoot(remote);
  const dryRun = () => env.CEZ_DRY_RUN === '1';

  let detected: { at: number; value: ForgeAvailability } | null = null;
  let detecting: Promise<ForgeAvailability> | null = null;
  let facts: RepoFacts | null = null;
  let listed: { at: number; items: ForgeItem[] } | null = null;

  const repoFacts = async (): Promise<RepoFacts | { reason: string }> => {
    // RepoFacts has no index signature, so `'reason' in` narrows it soundly.
    if (facts) return facts;
    const res = await t.request('GET', ['git', 'repositories', remote.repo]);
    if (!res.ok) return { reason: res.reason };
    const parsed = repoSchema.safeParse(res.json);
    if (!parsed.success) return { reason: 'Azure DevOps answered an unexpected repository shape' };
    facts = { id: parsed.data.id, projectId: parsed.data.project.id, defaultBranch: parsed.data.defaultBranch };
    return facts;
  };

  const getPr = async (
    id: number,
  ): Promise<{ ok: true; pr: AzurePr } | { ok: false; reason: string; status: number }> => {
    const res = await t.request('GET', ['git', 'pullrequests', String(id)]);
    if (!res.ok) return { ok: false, reason: res.reason, status: res.status };
    const parsed = azurePrSchema.safeParse(res.json);
    return parsed.success
      ? { ok: true, pr: parsed.data }
      : { ok: false, reason: 'Azure DevOps answered an unexpected pull request shape', status: 502 };
  };

  const listWhere = async (query: Record<string, string | number>): Promise<AzurePr[] | null> => {
    const res = await t.request('GET', ['git', 'repositories', remote.repo, 'pullrequests'], { query });
    if (!res.ok) return null;
    return parseEach(azurePrSchema, azurePrListSchema.parse(res.json).value);
  };

  const checksOf = async (pr: AzurePr): Promise<{ evaluations: AzureEvaluation[]; statuses: AzureStatus[] }> => {
    const repo = await repoFacts();
    const projectId = pr.repository?.project?.id ?? ('projectId' in repo ? repo.projectId : undefined);
    const [evals, stats] = await Promise.all([
      projectId
        ? t.request('GET', ['policy', 'evaluations'], {
            query: { artifactId: `vstfs:///CodeReview/CodeReviewId/${projectId}/${pr.pullRequestId}` },
          })
        : Promise.resolve(null),
      t.request('GET', ['git', 'repositories', remote.repo, 'pullRequests', String(pr.pullRequestId), 'statuses']),
    ]);
    const rows = (r: typeof stats | null) => (r && r.ok ? azurePrListSchema.parse(r.json).value : []);
    return { evaluations: parseEach(azureEvaluationSchema, rows(evals)), statuses: parseEach(azureStatusSchema, rows(stats)) };
  };

  const mergeState = async (id: number): Promise<ForgePrMergeStateResult> => {
    if (dryRun()) return { available: false, reason: 'dry run — Azure DevOps is not called' };
    const got = await getPr(id);
    if (!got.ok) return { available: false, reason: got.reason };
    const { evaluations, statuses } = await checksOf(got.pr);
    return { available: true, mergeState: toMergeState(got.pr, webRoot, evaluations, statuses) };
  };

  const driver: AzureForgeDriver = {
    kind: 'azure-devops',

    async markPrReady(number) {
      if (dryRun()) return { ok: true };
      const res = await t.request('PATCH', ['git', 'repositories', remote.repo, 'pullrequests', String(number)], {
        body: { isDraft: false },
      });
      return res.ok ? { ok: true } : { ok: false, error: res.reason };
    },

    async detect() {
      if (dryRun()) return { available: false, reason: 'dry run — Azure DevOps is not called' };
      if (detected && now() - detected.at < DETECT_TTL_MS) return detected.value;
      detecting ??= (async () => {
        facts = null;
        const repo = await repoFacts();
        const value: ForgeAvailability = 'reason' in repo ? { available: false, reason: repo.reason } : { available: true };
        detected = { at: now(), value };
        detecting = null;
        return value;
      })();
      return detecting;
    },

    detectCached() {
      return detected?.value ?? null;
    },

    async listIssues() {
      return []; // Azure Boards work items are out of scope (spec, Scope).
    },

    async listPRs(opts = {}) {
      if (dryRun()) return [];
      if (!opts.refresh && listed && now() - listed.at < LIST_TTL_MS) return listed.items;
      const prs = await listWhere({ 'searchCriteria.status': 'active', $top: Math.min(opts.limit ?? LIST_MAX, LIST_MAX) });
      if (!prs) return listed?.items ?? [];
      const items = prs.map((pr) => toForgeItem(pr, webRoot));
      listed = { at: now(), items };
      return items;
    },

    async searchItems(kind, query, opts = {}): Promise<ForgeSearchData> {
      if (kind === 'issue') return { available: false, reason: 'Azure Boards work items are not supported yet', items: [] };
      if (dryRun()) return { available: false, reason: 'dry run — Azure DevOps is not called', items: [] };
      const q = query.trim().replace(/^[#!]/, '');
      if (/^\d+$/.test(q)) {
        const got = await getPr(Number(q));
        if (!got.ok) return got.status === 404 ? { available: true, items: [] } : { available: false, reason: got.reason, items: [] };
        return { available: true, items: [toForgeItem(got.pr, webRoot)] };
      }
      // No title search in Azure Repos (D7): filter the newest page, any state, and say it was a page.
      const prs = await listWhere({ 'searchCriteria.status': 'all', $top: LIST_MAX });
      if (!prs) return { available: false, reason: 'cannot list pull requests in Azure DevOps', items: [] };
      const needle = q.toLowerCase();
      const hits = prs.filter((pr) => pr.title.toLowerCase().includes(needle)).slice(0, opts.limit ?? LIST_MAX);
      return { available: true, items: hits.map((pr) => toForgeItem(pr, webRoot)), truncated: prs.length >= LIST_MAX };
    },

    async createPR(input: DraftPrInput): Promise<DraftPrOutcome> {
      const { run } = input;
      const worktree = run.worktreePath;
      const branch = run.branch;
      const existing = input.updateExisting ? run.pullRequestUrl : undefined;
      if (!worktree || !branch) return { ok: false, error: 'this task has no worktree/branch to publish' };
      const saved = await autosaveCommit(worktree, 'pre-PR');
      if (saved === 'refused') return { ok: false, error: 'worktree has unresolved merge conflicts — resolve them, then publish again' };
      if (saved === 'failed') return { ok: false, error: 'could not commit the final changes — check git status in the worktree' };
      if (dryRun()) {
        return existing
          ? { ok: true, url: existing, dryRun: true, updated: true }
          : { ok: true, url: prUrl(webRoot, 777), dryRun: true };
      }
      const remotes = await taskRemotes(worktree);
      if (!remotes.push) return { ok: false, error: 'no git remote — add one or merge the branch locally' };
      const prBase = run.baseBranch ? splitRemoteRef(run.baseBranch, remotes.names).branch : undefined;
      const target = prBase && !/^[0-9a-f]{7,40}$/i.test(prBase) ? prBase : undefined;
      if (!existing && (await baseDivergence(worktree, run.baseBranch)).ahead === 0) {
        return { ok: false, error: `nothing to propose — ${branch} has no commits that ${target ?? 'the base branch'} does not already have` };
      }
      let push = await gitIn(worktree, ['push', '-u', remotes.push, branch], PUSH_TIMEOUT_MS);
      if (!push.ok && /\[rejected\]|non-fast-forward/.test(push.stderr)) {
        const lease = await rewriteLeaseArg(worktree, remotes.push, branch, [run.baseBranch, prBase]);
        if (lease) push = await gitIn(worktree, ['push', lease, '-u', remotes.push, branch], PUSH_TIMEOUT_MS);
      }
      if (!push.ok) return { ok: false, error: `git push failed — ${lastLine(push.stderr) || 'unknown error'}` };
      if (existing) return { ok: true, url: existing, dryRun: false, updated: true };

      // Publishing is idempotent: a PR already open from this branch is adopted, never opened twice.
      const open = await listWhere({ 'searchCriteria.sourceRefName': `refs/heads/${branch}`, 'searchCriteria.status': 'active' });
      if (open?.[0]) return { ok: true, url: prUrl(webRoot, open[0].pullRequestId), dryRun: false, updated: true };

      const repo = await repoFacts();
      const targetRef = target ? `refs/heads/${target}` : 'defaultBranch' in repo ? repo.defaultBranch : undefined;
      if (!targetRef) return { ok: false, error: 'cannot tell which branch the pull request should target' };
      const body = buildPrBody(input.handoffText, run.task);
      const res = await t.request('POST', ['git', 'repositories', remote.repo, 'pullrequests'], {
        body: {
          sourceRefName: `refs/heads/${branch}`,
          targetRefName: targetRef,
          title: run.title,
          description: body.length > DESCRIPTION_MAX ? `${body.slice(0, DESCRIPTION_MAX - 1)}…` : body,
          isDraft: input.draft !== false,
        },
      });
      if (!res.ok) return { ok: false, error: `could not open the pull request — ${res.reason}` };
      const created = azurePrSchema.safeParse(res.json);
      return created.success
        ? { ok: true, url: prUrl(webRoot, created.data.pullRequestId), dryRun: false }
        : { ok: false, error: 'Azure DevOps opened no pull request we could read — check the repository' };
    },

    async prStatus(branch): Promise<ForgePrStatus | null> {
      if (dryRun()) return null;
      const prs = await listWhere({ 'searchCriteria.sourceRefName': `refs/heads/${branch}`, 'searchCriteria.status': 'all', $top: 5 });
      const pr = prs?.find((p) => p.status === 'active') ?? prs?.[0];
      if (!pr) return null;
      const { evaluations, statuses } = await checksOf(pr);
      return toPrStatus(pr, webRoot, toChecks(evaluations, statuses));
    },

    prMergeState: (number) => mergeState(number),

    async mergePR(number, input: ForgeMergeInput): Promise<ForgeMergeResult> {
      const before = await mergeState(number);
      if (!before.available) return { merged: false, status: 502, error: before.reason };
      const current = before.mergeState;
      if (current.state !== 'open') return { merged: false, status: 409, error: `the pull request is already ${current.state}`, current };
      if (current.headSha && input.expectedHeadSha && current.headSha !== input.expectedHeadSha) {
        return { merged: false, status: 409, code: 'head-moved', error: 'the branch moved since it was checked — look again', current };
      }
      if (!current.methods.includes(input.method)) {
        return { merged: false, status: 409, error: `this branch does not allow a ${input.method} merge`, current };
      }
      const res = await t.request('PATCH', ['git', 'repositories', remote.repo, 'pullrequests', String(number)], {
        body: {
          status: 'completed',
          // A moved head is refused by Azure itself, not only by the check above (provider spec, merge facet).
          lastMergeSourceCommit: { commitId: input.expectedHeadSha || current.headSha },
          completionOptions: { mergeStrategy: MERGE_STRATEGY[input.method], deleteSourceBranch: false },
        },
      });
      if (!res.ok) {
        const status = res.status === 403 ? 403 : res.status === 404 ? 404 : res.status === 0 ? 502 : 409;
        return { merged: false, status, error: res.reason, current };
      }
      // Completion is asynchronous: re-read until Azure reports it (provider spec, merge facet).
      for (let i = 0; i < COMPLETE_REREADS; i++) {
        const got = await getPr(number);
        if (got.ok && got.pr.status === 'completed') {
          return {
            merged: true,
            number,
            url: prUrl(webRoot, number),
            method: input.method,
            ...(got.pr.lastMergeCommit?.commitId ? { mergeCommitSha: got.pr.lastMergeCommit.commitId } : {}),
          };
        }
        await sleep(COMPLETE_GAP_MS);
      }
      const after = await mergeState(number);
      return {
        merged: false,
        status: 409,
        code: 'queued',
        error: 'Azure DevOps accepted the completion but has not finished it yet — it usually does within a minute',
        ...(after.available ? { current: after.mergeState } : {}),
      };
    },

    viewUrl(kind: ForgeRefKind, ref: string | number): string | null {
      const r = String(ref);
      if (kind === 'repo') return webRoot;
      if (kind === 'pr') return /^\d+$/.test(r) ? prUrl(webRoot, Number(r)) : null;
      if (kind === 'issue') return /^\d+$/.test(r) ? `${azureProjectRoot(remote)}/_workitems/edit/${r}` : null;
      if (kind === 'branch') return `${webRoot}?version=GB${encodeURIComponent(branchOf(r))}`;
      if (kind === 'commit') return /^[0-9a-f]{7,40}$/i.test(r) ? `${webRoot}/commit/${r}` : null;
      return null;
    },
  };
  return driver;
}
