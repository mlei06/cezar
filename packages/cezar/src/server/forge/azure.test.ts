import { describe, expect, it } from 'vitest';
import { createAzureDriver } from './azure.ts';
import { resolveForge, forgeKindOfRemote, forgeWebRoot } from './index.ts';
import { prNumberOfUrl, PR_URL_RE } from './pr-url.ts';
import type { ToolRunner } from './azure/auth.ts';

const remote = { host: 'dev.azure.com' as const, org: 'acme', project: 'shop', repo: 'web' };
const WEB = 'https://dev.azure.com/acme/shop/_git/web';
const HEAD = 'a'.repeat(40);

const pr = (over: Record<string, unknown> = {}) => ({
  pullRequestId: 12,
  title: 'Merge upstream v0.14',
  status: 'active',
  isDraft: false,
  createdBy: { displayName: 'Dana' },
  creationDate: '2026-11-20T10:00:00Z',
  sourceRefName: 'refs/heads/cez/12345678',
  targetRefName: 'refs/heads/main',
  mergeStatus: 'succeeded',
  lastMergeSourceCommit: { commitId: HEAD },
  reviewers: [],
  labels: [{ name: 'upstream', active: true }],
  repository: { id: 'r1', project: { id: 'p1' } },
  ...over,
});

const buildPolicy = (status: string) => ({
  status,
  configuration: {
    isBlocking: true,
    isEnabled: true,
    type: { id: '0609b952-1397-4640-95ec-e00a01b2c241', displayName: 'Build' },
    settings: { displayName: 'CI' },
  },
});

/** A tiny Azure DevOps: `routes[method + ' ' + path]` answers, everything else 404. */
function fakeAzure(routes: Record<string, (body?: unknown) => { status: number; json?: unknown }>) {
  const calls: Array<{ method: string; path: string; query: URLSearchParams; body?: unknown; auth?: string }> = [];
  const fetch = async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname.replace('/acme/shop/_apis/', ''));
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method!, path, query: u.searchParams, body, auth: (init.headers as Record<string, string>).Authorization });
    const hit = routes[`${init.method} ${path}`]?.(body) ?? { status: 404, json: { message: 'nope' } };
    return new Response(hit.json === undefined ? '' : JSON.stringify(hit.json), { status: hit.status });
  };
  return { fetch, calls };
}

const run: ToolRunner = async () => ({ ok: true, stdout: 'username=me\npassword=pat\n', notFound: false });
const driverFor = (routes: Parameters<typeof fakeAzure>[0], sleep = async () => {}) => {
  const api = fakeAzure(routes);
  return { api, driver: createAzureDriver(remote, { fetch: api.fetch, run, env: {}, sleep }) };
};

describe('resolveForge picks Azure Repos from the remote', () => {
  it('classifies Azure remotes, rebuilds their web root, and leaves GitHub to the GitHub driver', () => {
    expect(forgeKindOfRemote('https://dev.azure.com/acme/shop/_git/web')).toBe('azure-devops');
    expect(forgeWebRoot('https://me:tok@dev.azure.com/acme/shop/_git/web')).toBe(WEB);
    expect(resolveForge({ root: '/r', remote: 'git@ssh.dev.azure.com:v3/acme/shop/web' } as never)?.kind).toBe('azure-devops');
    expect(resolveForge({ root: '/r', remote: 'https://github.com/acme/web.git' } as never)?.kind).toBe('github');
  });
});

describe('PR URLs on both forges', () => {
  it('reads the number from either form, and finds either in text', () => {
    expect(prNumberOfUrl('https://github.com/o/r/pull/7')).toBe(7);
    expect(prNumberOfUrl(`${WEB}/pullrequest/12`)).toBe(12);
    expect(prNumberOfUrl(`${WEB}/pullrequest/12?_a=files`)).toBe(12);
    expect(prNumberOfUrl('https://github.com/o/r/issues/7')).toBeUndefined();
    expect(PR_URL_RE.exec(`opened ${WEB}/pullrequest/12 just now`)?.[0]).toBe(`${WEB}/pullrequest/12`);
  });
});

describe('createAzureDriver (spec 2026-11-24-azure-repos-forge-driver)', () => {
  it('detects through the repository, with the credential git holds', async () => {
    const { driver, api } = driverFor({ 'GET git/repositories/web': () => ({ status: 200, json: { id: 'r1', project: { id: 'p1' } } }) });
    expect(driver.detectCached()).toBeNull();
    expect(await driver.detect()).toEqual({ available: true });
    expect(driver.detectCached()).toEqual({ available: true });
    expect(api.calls[0]!.auth).toBe(`Basic ${Buffer.from('me:pat').toString('base64')}`);
    expect(api.calls[0]!.query.get('api-version')).toBe('7.1');
  });

  it('degrades with the reason when the repository is unreachable', async () => {
    const { driver } = driverFor({});
    expect(await driver.detect()).toEqual({ available: false, reason: 'nope' });
  });

  it('lists open PRs in the cockpit item shape', async () => {
    const { driver, api } = driverFor({ 'GET git/repositories/web/pullrequests': () => ({ status: 200, json: { value: [pr({ isDraft: true })] } }) });
    expect(await driver.listPRs()).toEqual([
      {
        kind: 'pr',
        number: 12,
        title: 'Merge upstream v0.14',
        author: 'Dana',
        createdAt: '2026-11-20T10:00:00Z',
        labels: ['upstream'],
        url: `${WEB}/pullrequest/12`,
        comments: 0,
        isDraft: true,
      },
    ]);
    expect(api.calls[0]!.query.get('searchCriteria.status')).toBe('active');
    expect(await driver.listIssues()).toEqual([]); // Boards are out of scope
  });

  it('searches by id directly and by title over the newest page', async () => {
    const { driver } = driverFor({
      'GET git/pullrequests/12': () => ({ status: 200, json: pr() }),
      'GET git/repositories/web/pullrequests': () => ({ status: 200, json: { value: [pr(), pr({ pullRequestId: 13, title: 'Fix login' })] } }),
    });
    expect((await driver.searchItems!('pr', '#12')).items.map((i) => i.number)).toEqual([12]);
    expect((await driver.searchItems!('pr', 'login')).items.map((i) => i.number)).toEqual([13]);
    expect((await driver.searchItems!('issue', '1')).available).toBe(false);
  });

  it("reports a branch's PR with its checks", async () => {
    const { driver } = driverFor({
      'GET git/repositories/web': () => ({ status: 200, json: { id: 'r1', project: { id: 'p1' } } }),
      'GET git/repositories/web/pullrequests': () => ({ status: 200, json: { value: [pr()] } }),
      'GET policy/evaluations': () => ({ status: 200, json: { value: [buildPolicy('running')] } }),
      'GET git/repositories/web/pullRequests/12/statuses': () => ({ status: 200, json: { value: [] } }),
    });
    expect(await driver.prStatus('cez/12345678')).toEqual({
      number: 12,
      url: `${WEB}/pullrequest/12`,
      state: 'open',
      isDraft: false,
      checks: 'pending',
    });
  });

  it('maps merge state: policies, votes and the default merge method', async () => {
    const { driver } = driverFor({
      'GET git/pullrequests/12': () => ({ status: 200, json: pr({ reviewers: [{ vote: 10 }] }) }),
      'GET policy/evaluations': () => ({ status: 200, json: { value: [buildPolicy('approved')] } }),
      'GET git/repositories/web/pullRequests/12/statuses': () => ({
        status: 200,
        json: { value: [{ state: 'succeeded', context: { genre: 'jenkins', name: 'deploy-check' }, targetUrl: 'https://ci.example.test/1' }] },
      }),
    });
    const result = await driver.prMergeState!(12);
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.mergeState).toMatchObject({
      state: 'open',
      headSha: HEAD,
      headRef: 'cez/12345678',
      baseRef: 'main',
      mergeable: 'mergeable',
      reviewDecision: 'approved',
      eligibility: 'ready',
      blockers: [],
      methods: ['merge', 'squash', 'rebase'],
      defaultMethod: 'merge',
      canOverride: false,
    });
    expect(result.mergeState.checks).toEqual([
      { name: 'CI', state: 'passing', required: true },
      { name: 'jenkins/deploy-check', state: 'passing', required: null, url: 'https://ci.example.test/1' },
    ]);
  });

  it('completes a PR as a merge commit and waits for Azure to finish it', async () => {
    let completed = false;
    const { driver, api } = driverFor({
      'GET git/pullrequests/12': () => ({ status: 200, json: pr(completed ? { status: 'completed', lastMergeCommit: { commitId: 'b'.repeat(40) } } : {}) }),
      'GET policy/evaluations': () => ({ status: 200, json: { value: [] } }),
      'GET git/repositories/web/pullRequests/12/statuses': () => ({ status: 200, json: { value: [] } }),
      'PATCH git/repositories/web/pullrequests/12': () => {
        completed = true;
        return { status: 200, json: pr() };
      },
    });
    const merged = await driver.mergePR!(12, { method: 'merge', expectedHeadSha: HEAD });
    expect(merged).toEqual({ merged: true, number: 12, url: `${WEB}/pullrequest/12`, method: 'merge', mergeCommitSha: 'b'.repeat(40) });
    expect(api.calls.find((c) => c.method === 'PATCH')!.body).toEqual({
      status: 'completed',
      lastMergeSourceCommit: { commitId: HEAD },
      completionOptions: { mergeStrategy: 'noFastForward', deleteSourceBranch: false },
    });
  });

  it('refuses a moved head before sending anything', async () => {
    const { driver, api } = driverFor({
      'GET git/pullrequests/12': () => ({ status: 200, json: pr() }),
      'GET policy/evaluations': () => ({ status: 200, json: { value: [] } }),
      'GET git/repositories/web/pullRequests/12/statuses': () => ({ status: 200, json: { value: [] } }),
    });
    const result = await driver.mergePR!(12, { method: 'merge', expectedHeadSha: 'c'.repeat(40) });
    expect(result).toMatchObject({ merged: false, status: 409, code: 'head-moved' });
    expect(api.calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('reports a completion Azure queued but has not finished', async () => {
    const { driver } = driverFor({
      'GET git/pullrequests/12': () => ({ status: 200, json: pr({ completionQueueTime: '2026-11-24T10:00:00Z' }) }),
      'GET policy/evaluations': () => ({ status: 200, json: { value: [] } }),
      'GET git/repositories/web/pullRequests/12/statuses': () => ({ status: 200, json: { value: [] } }),
      'PATCH git/repositories/web/pullrequests/12': () => ({ status: 200, json: pr() }),
    });
    expect(await driver.mergePR!(12, { method: 'merge', expectedHeadSha: HEAD })).toMatchObject({ merged: false, code: 'queued' });
  });

  it('asks again once after a 401, with a fresh credential', async () => {
    let first = true;
    const { driver, api } = driverFor({
      'GET git/repositories/web': () => {
        if (first) {
          first = false;
          return { status: 401 };
        }
        return { status: 200, json: { id: 'r1', project: { id: 'p1' } } };
      },
    });
    expect(await driver.detect()).toEqual({ available: true });
    expect(api.calls).toHaveLength(2);
  });

  it('builds web URLs without asking Azure', () => {
    const { driver } = driverFor({});
    expect(driver.viewUrl('repo', '')).toBe(WEB);
    expect(driver.viewUrl('pr', 12)).toBe(`${WEB}/pullrequest/12`);
    expect(driver.viewUrl('issue', 7)).toBe('https://dev.azure.com/acme/shop/_workitems/edit/7');
    expect(driver.viewUrl('branch', 'refs/heads/cez/1')).toBe(`${WEB}?version=GBcez%2F1`);
    expect(driver.viewUrl('commit', HEAD)).toBe(`${WEB}/commit/${HEAD}`);
  });
});
