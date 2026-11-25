import { describe, expect, it } from 'vitest';
import type { AzureForgeDriver } from './azure.ts';
import { azureChecks, azureGithubData, azureRefStatus, refStatusOf } from './azure-routes.ts';
import type { ForgePrMergeState } from './types.ts';

const state = (over: Partial<ForgePrMergeState> = {}): ForgePrMergeState => ({
  number: 1,
  title: 't',
  url: 'https://dev.azure.com/a/p/_git/r/pullrequest/1',
  state: 'open',
  isDraft: false,
  headRef: 'h',
  baseRef: 'main',
  headSha: 'a'.repeat(40),
  mergeable: 'mergeable',
  reviewDecision: 'not-required',
  checks: [],
  checksTier: 'detailed',
  methods: ['merge'],
  defaultMethod: 'merge',
  eligibility: 'ready',
  blockers: [],
  canMerge: true,
  canOverride: false,
  ...over,
});

const driver = (states: Record<number, ForgePrMergeState | null>, over: Partial<AzureForgeDriver> = {}) =>
  ({
    detect: async () => ({ available: true }),
    listPRs: async () => [],
    prMergeState: async (n: number) =>
      states[n] ? { available: true as const, mergeState: states[n]! } : { available: false as const, reason: 'not found' },
    ...over,
  }) as unknown as AzureForgeDriver;

describe('the /github routes on Azure Repos (spec 2026-11-24-azure-repos-forge-driver)', () => {
  it("names a PR's chip the way GitHub's do", () => {
    expect(refStatusOf(state({ state: 'merged' }))).toBe('merged');
    expect(refStatusOf(state({ state: 'closed' }))).toBe('closed');
    expect(refStatusOf(state({ isDraft: true }))).toBe('draft');
    expect(refStatusOf(state({ reviewDecision: 'changes-requested' }))).toBe('changes-requested');
    expect(refStatusOf(state({ checks: [{ name: 'CI', state: 'failing', required: true }] }))).toBe('checks-failing');
    expect(refStatusOf(state({ checks: [{ name: 'CI', state: 'pending', required: true }] }))).toBe('checks-pending');
    expect(refStatusOf(state({ reviewDecision: 'review-required' }))).toBe('review-required');
    expect(refStatusOf(state())).toBe('ready');
  });

  it('batches chip statuses, flags conflicts, and stops rechecking once nothing is open', async () => {
    const open = await azureRefStatus(driver({ 1: state({ mergeable: 'conflicting' }), 2: state({ state: 'merged' }) }), [1, 2]);
    expect(open).toEqual({ available: true, prs: { 1: 'ready', 2: 'merged' }, issues: {}, conflicts: [1], recheckAfterMs: 60_000 });
    const done = await azureRefStatus(driver({ 2: state({ state: 'merged' }) }), [2]);
    expect(done).toMatchObject({ available: true, recheckAfterMs: null });
    expect(await azureRefStatus(driver({}), [9])).toMatchObject({ available: false, reason: 'not found' });
  });

  it("answers the list with open PRs and no issues, or the forge's reason", async () => {
    expect(await azureGithubData(driver({}), false, 50)).toMatchObject({ available: true, issues: [], prs: [], prsTotal: 0 });
    const down = driver({}, { detect: async () => ({ available: false, reason: 'no Azure DevOps credential' }) });
    expect(await azureGithubData(down, false, 50)).toEqual({ available: false, reason: 'no Azure DevOps credential', issues: [], prs: [] });
  });

  it('answers check glyphs per PR', async () => {
    const checks = [{ name: 'CI', state: 'passing' as const, required: true }];
    expect(await azureChecks(driver({ 1: state({ checks }) }), [1])).toEqual({ available: true, checks: { 1: 'passing' } });
  });
});
