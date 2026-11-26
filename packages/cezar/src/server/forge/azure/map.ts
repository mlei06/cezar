import { z } from 'zod';
import type {
  ForgeItem,
  ForgeMergeMethod,
  ForgePrCheck,
  ForgePrMergeState,
  ForgePrStatus,
} from '../types.ts';

/**
 * Azure Repos JSON → the forge seam's shapes (spec 2026-11-24-azure-repos-forge-driver D4–D6; field tables from the
 * provider spec's merge facet, #1617). Pure functions, zod at the boundary: a field Azure omits or changes degrades
 * to a neutral value, never a throw.
 */

const identity = z.object({ displayName: z.string().catch(''), uniqueName: z.string().catch('') }).partial().catch({});

export const azurePrSchema = z
  .object({
    pullRequestId: z.number().int().positive(),
    title: z.string().catch(''),
    description: z.string().optional().catch(undefined),
    status: z.enum(['active', 'completed', 'abandoned', 'notSet', 'all']).catch('notSet'),
    isDraft: z.boolean().catch(false),
    createdBy: identity,
    creationDate: z.string().catch(''),
    sourceRefName: z.string().catch(''),
    targetRefName: z.string().catch(''),
    mergeStatus: z.string().optional().catch(undefined),
    mergeFailureMessage: z.string().optional().catch(undefined),
    lastMergeSourceCommit: z.object({ commitId: z.string() }).optional().catch(undefined),
    lastMergeCommit: z.object({ commitId: z.string() }).optional().catch(undefined),
    closedDate: z.string().optional().catch(undefined),
    reviewers: z
      .array(z.object({ vote: z.number().catch(0), isRequired: z.boolean().optional().catch(undefined) }).passthrough())
      .catch([]),
    labels: z.array(z.object({ name: z.string(), active: z.boolean().optional() }).passthrough()).catch([]),
    repository: z
      .object({ id: z.string().optional(), project: z.object({ id: z.string() }).optional() })
      .passthrough()
      .optional()
      .catch(undefined),
    autoCompleteSetBy: identity.optional(),
    completionQueueTime: z.string().optional().catch(undefined),
  })
  .passthrough();
export type AzurePr = z.infer<typeof azurePrSchema>;

export const azurePrListSchema = z.object({ value: z.array(z.unknown()).catch([]) }).catch({ value: [] });

export const azureEvaluationSchema = z
  .object({
    status: z.string().catch('unknown'),
    configuration: z
      .object({
        isBlocking: z.boolean().catch(false),
        isEnabled: z.boolean().catch(true),
        type: z.object({ id: z.string().catch(''), displayName: z.string().catch('Policy') }).catch({ id: '', displayName: 'Policy' }),
        settings: z.record(z.string(), z.unknown()).catch({}),
      })
      .passthrough(),
  })
  .passthrough();
export type AzureEvaluation = z.infer<typeof azureEvaluationSchema>;

export const azureStatusSchema = z
  .object({
    state: z.string().catch('notSet'),
    context: z.object({ name: z.string().catch(''), genre: z.string().optional().catch(undefined) }).catch({ name: '' }),
    targetUrl: z.string().optional().catch(undefined),
  })
  .passthrough();
export type AzureStatus = z.infer<typeof azureStatusSchema>;

/** Every element that parses; one bad row never drops the rest. */
export function parseEach<T>(schema: z.ZodType<T>, rows: unknown[]): T[] {
  const out: T[] = [];
  for (const row of rows) {
    const parsed = schema.safeParse(row);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

const MERGE_STRATEGY_POLICY = 'fa4e907d-c16b-4a4c-9dfa-4916e5d171ab';
const BUILD_POLICY = '0609b952-1397-4640-95ec-e00a01b2c241';
const REVIEWER_POLICIES = new Set([
  'fa4e907d-c16b-4a4c-9dfa-4906e5d171dd', // Minimum number of reviewers
  'fd2167ab-b0be-447a-8ec8-39368250530e', // Required reviewers
]);

export const branchOf = (ref: string) => ref.replace(/^refs\/heads\//, '');
export const prUrl = (webRoot: string, id: number) => `${webRoot}/pullrequest/${id}`;

function prState(pr: AzurePr): 'open' | 'merged' | 'closed' {
  return pr.status === 'completed' ? 'merged' : pr.status === 'abandoned' ? 'closed' : 'open';
}

export function toForgeItem(pr: AzurePr, webRoot: string): ForgeItem {
  return {
    kind: 'pr',
    number: pr.pullRequestId,
    title: pr.title,
    author: pr.createdBy.displayName || pr.createdBy.uniqueName || '?',
    createdAt: pr.creationDate,
    labels: pr.labels.filter((l) => l.active !== false).map((l) => l.name),
    url: prUrl(webRoot, pr.pullRequestId),
    comments: 0,
    isDraft: pr.isDraft,
  };
}

const checkState = (s: string): ForgePrCheck['state'] => {
  const v = s.toLowerCase();
  if (v === 'approved' || v === 'succeeded') return 'passing';
  if (v === 'rejected' || v === 'failed' || v === 'error' || v === 'broken') return 'failing';
  if (v === 'running' || v === 'queued' || v === 'pending') return 'pending';
  return 'unknown';
};

/** Build-policy evaluations and PR statuses, one row each (D6). */
export function toChecks(evaluations: AzureEvaluation[], statuses: AzureStatus[]): ForgePrCheck[] {
  const rows: ForgePrCheck[] = [];
  for (const e of evaluations) {
    if (!e.configuration.isEnabled || e.configuration.type.id !== BUILD_POLICY) continue;
    const name = typeof e.configuration.settings.displayName === 'string' && e.configuration.settings.displayName
      ? String(e.configuration.settings.displayName)
      : e.configuration.type.displayName;
    if (e.status.toLowerCase() === 'notapplicable') continue;
    rows.push({ name, state: checkState(e.status), required: e.configuration.isBlocking });
  }
  for (const s of statuses) {
    if (s.state === 'notApplicable' || s.state === 'notSet') continue;
    const name = [s.context.genre, s.context.name].filter(Boolean).join('/') || 'status';
    rows.push({ name, state: checkState(s.state), required: null, ...(s.targetUrl ? { url: s.targetUrl } : {}) });
  }
  return rows;
}

export function checksGlyph(checks: ForgePrCheck[]): ForgePrStatus['checks'] {
  if (!checks.length) return null;
  if (checks.some((c) => c.state === 'failing')) return 'failing';
  if (checks.some((c) => c.state === 'pending' || c.state === 'unknown')) return 'pending';
  return 'passing';
}

export function toPrStatus(pr: AzurePr, webRoot: string, checks: ForgePrCheck[]): ForgePrStatus {
  return { number: pr.pullRequestId, url: prUrl(webRoot, pr.pullRequestId), state: prState(pr), isDraft: pr.isDraft, checks: checksGlyph(checks) };
}

/** Methods the target branch allows (D5): the merge-strategy policy, else all three with `merge` first. */
export function mergeMethods(evaluations: AzureEvaluation[]): { methods: ForgeMergeMethod[]; defaultMethod: ForgeMergeMethod } {
  const policy = evaluations.find((e) => e.configuration.isEnabled && e.configuration.type.id === MERGE_STRATEGY_POLICY);
  if (!policy) return { methods: ['merge', 'squash', 'rebase'], defaultMethod: 'merge' };
  const s = policy.configuration.settings;
  const methods: ForgeMergeMethod[] = [];
  if (s.allowNoFastForward === true) methods.push('merge');
  if (s.allowSquash === true) methods.push('squash');
  if (s.allowRebase === true || s.allowRebaseMerge === true) methods.push('rebase');
  const allowed = methods.length ? methods : (['merge', 'squash', 'rebase'] as ForgeMergeMethod[]);
  return { methods: allowed, defaultMethod: allowed[0]! };
}

/** The Azure merge strategy for a cezar method (D5). */
export const MERGE_STRATEGY: Record<ForgeMergeMethod, string> = {
  merge: 'noFastForward',
  squash: 'squash',
  rebase: 'rebase',
};

export function toMergeState(
  pr: AzurePr,
  webRoot: string,
  evaluations: AzureEvaluation[],
  statuses: AzureStatus[],
): ForgePrMergeState {
  const state = prState(pr);
  const checks = toChecks(evaluations, statuses);
  const mergeStatus = (pr.mergeStatus ?? '').toLowerCase();
  const mergeable: ForgePrMergeState['mergeable'] =
    mergeStatus === 'succeeded' ? 'mergeable' : mergeStatus === 'conflicts' ? 'conflicting' : 'unknown';

  const votes = pr.reviewers.map((r) => r.vote);
  const reviewerGate = evaluations.find(
    (e) => e.configuration.isEnabled && REVIEWER_POLICIES.has(e.configuration.type.id) && e.status.toLowerCase() !== 'approved',
  );
  const reviewDecision: ForgePrMergeState['reviewDecision'] = votes.some((v) => v === -10 || v === -5)
    ? 'changes-requested'
    : reviewerGate
      ? 'review-required'
      : votes.some((v) => v >= 5)
        ? 'approved'
        : 'not-required';

  const blockers: ForgePrMergeState['blockers'] = [];
  if (pr.isDraft) blockers.push({ code: 'draft', message: 'the pull request is a draft' });
  if (mergeable === 'conflicting') blockers.push({ code: 'conflicts', message: 'the branch conflicts with its target' });
  if (mergeStatus === 'rejectedbypolicy' || mergeStatus === 'failure')
    blockers.push({ code: 'merge-failure', message: pr.mergeFailureMessage || 'Azure DevOps cannot merge this branch' });
  let pending = false;
  for (const e of evaluations) {
    if (!e.configuration.isEnabled || !e.configuration.isBlocking || e.configuration.type.id === MERGE_STRATEGY_POLICY) continue;
    const s = e.status.toLowerCase();
    if (s === 'approved' || s === 'notapplicable') continue;
    if (s === 'running' || s === 'queued') pending = true;
    blockers.push({ code: e.configuration.type.displayName, message: `${e.configuration.type.displayName}: ${e.status}` });
  }

  const eligibility: ForgePrMergeState['eligibility'] =
    state !== 'open' ? 'terminal' : blockers.length === 0 ? 'ready' : pending && blockers.every((b) => b.code !== 'draft' && b.code !== 'conflicts' && b.code !== 'merge-failure') ? 'pending' : 'blocked';

  return {
    number: pr.pullRequestId,
    title: pr.title,
    url: prUrl(webRoot, pr.pullRequestId),
    state,
    isDraft: pr.isDraft,
    headRef: branchOf(pr.sourceRefName),
    baseRef: branchOf(pr.targetRefName),
    headSha: pr.lastMergeSourceCommit?.commitId ?? '',
    ...(state === 'merged' && pr.lastMergeCommit?.commitId ? { mergeCommitSha: pr.lastMergeCommit.commitId } : {}),
    ...(state === 'merged' && pr.closedDate ? { mergedAt: pr.closedDate } : {}),
    mergeable,
    reviewDecision,
    checks,
    checksTier: 'detailed',
    ...mergeMethods(evaluations),
    eligibility,
    blockers,
    // Not knowable without a permission probe: the completion PATCH answers (provider spec, merge facet).
    canMerge: true,
    canOverride: false,
  };
}
