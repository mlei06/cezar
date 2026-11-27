import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Every `gh` subprocess is answered here, never by a real CLI on PATH; any `gh` the stub does not
// route fails inside it and is recorded. Other commands (git) run for real.
const gh = vi.hoisted(() => ({
  calls: [] as Array<{ argv: string[]; env: Record<string, string | undefined> }>,
  unhandled: [] as string[],
  answer: (_argv: string[]): unknown => undefined,
}));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const isGh = (command: unknown) => typeof command === 'string' && /^gh(\.exe)?$/i.test(basename(command.trim().split(/\s+/)[0] ?? ''));
  const refuse = (what: string) => { gh.unhandled.push(what); throw new Error(`unhandled gh call: ${what}`); };
  const execFile = (...args: unknown[]) => {
    if (!isGh(args[0])) return (actual.execFile as (...a: unknown[]) => unknown)(...args);
    const argv = args[1] as string[];
    const opts = (typeof args[2] === 'object' && args[2] ? args[2] : {}) as { env?: Record<string, string | undefined> };
    const cb = args[args.length - 1] as (e: unknown, r?: unknown) => void;
    gh.calls.push({ argv, env: opts.env ?? {} });
    let value: unknown;
    try { value = gh.answer(argv); } catch (error) { cb(error, { stdout: '', stderr: '' }); return undefined; }
    if (value === undefined) {
      gh.unhandled.push(argv.join(' '));
      cb(Object.assign(new Error(`unhandled gh call: ${argv.join(' ')}`), { stdout: '', stderr: '' }), { stdout: '', stderr: '' });
    } else cb(null, { stdout: JSON.stringify(value), stderr: '' });
    return undefined;
  };
  // `promisify(execFile)` must keep resolving `{ stdout, stderr }`, for git and gh alike.
  const realPromised = (await import('node:util')).promisify(actual.execFile) as unknown as (...a: unknown[]) => Promise<unknown>;
  Object.assign(execFile, {
    [(await import('node:util')).promisify.custom]: (...args: unknown[]) => isGh(args[0])
      ? new Promise((resolve, reject) => { execFile(...args, (error: unknown, result: unknown) => (error ? reject(error) : resolve(result))); })
      : realPromised(...args),
  });
  const guard = <F extends (...a: never[]) => unknown>(name: string, real: F) =>
    ((...args: unknown[]) => (isGh(args[0]) ? refuse(`${name} ${String(args[0])}`) : (real as unknown as (...a: unknown[]) => unknown)(...args))) as unknown as F;
  return {
    ...actual,
    execFile,
    execFileSync: guard('execFileSync', actual.execFileSync),
    spawn: guard('spawn', actual.spawn),
    spawnSync: guard('spawnSync', actual.spawnSync),
    exec: guard('exec', actual.exec),
    execSync: guard('execSync', actual.execSync),
  };
});

const { execFileSync } = await import('node:child_process');
const { projectImprovementRecordsPath, readImprovementRecords } = await import('../improvement/bookkeeping.ts');
const { RunStore } = await import('../runs/store.ts');
const { registerProject } = await import('../workspace/projects.ts');
const { apiRequest } = await import('./loopback-request.testkit.ts');
const { createApp } = await import('./server.ts');
type RunManager = import('../workflows/run.ts').RunManager;

const HEAD = '0123456789abcdef0123456789abcdef01234567';
const MERGED = 'fedcba9876543210fedcba9876543210fedcba98';
const URL = 'https://github.com/acme/demo/pull/41';
const OTHER_URL = 'https://github.com/acme/other/pull/41';
const notFound = (message: string) =>
  Object.assign(new Error(`gh: ${message} (HTTP 404)`), { stdout: JSON.stringify({ message, status: '404' }), stderr: `gh: ${message} (HTTP 404)` });

describe('B30: a tracked improvement squash-merges under its PR title', () => {
  let repoRoot: string;
  let store: ReturnType<typeof RunStore.open>;
  let app: Hono;
  let projectId: string;
  let title: string;

  beforeEach(async () => {
    gh.calls.length = 0;
    gh.unhandled.length = 0;
    title = 'Improve factory reliability (#41)';
    // gh's default repository (no `--repo`) is another repo whose PR 41 shares the same head.
    gh.answer = (argv) => {
      const api = argv[0] === 'api' && argv[1] === '--hostname' ? ['api', ...argv.slice(3)] : argv;
      if (argv[0] === 'pr' && argv[1] === 'view') {
        if (argv.includes('statusCheckRollup')) return { statusCheckRollup: [] };
        const demo = argv[argv.indexOf('--repo') + 1] === 'github.com/acme/demo';
        return {
          number: 41, title: demo ? title : 'Unrelated default-repo PR', url: demo ? URL : OTHER_URL,
          state: 'OPEN', isDraft: false, headRefName: 'cez/abc12345', baseRefName: 'main', headRefOid: HEAD,
          mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: '',
        };
      }
      if (api[0] !== 'api') return undefined;
      if (api[1] === 'repos/acme/demo') {
        return { allow_squash_merge: true, allow_merge_commit: true, allow_rebase_merge: true, squash_merge_commit_title: 'COMMIT_OR_PR_TITLE' };
      }
      if (api[1] === 'repos/acme/demo/branches/main/protection/required_status_checks') throw notFound('Required status checks not enabled');
      if (api[1] === 'repos/acme/demo/branches/main/protection/required_pull_request_reviews') throw notFound('Required pull request reviews not enabled');
      if (api[1] === 'repos/acme/demo/rules/branches/main?per_page=100') return [];
      if (api[1] === '--method' && api[2] === 'PUT' && api[3] === 'repos/acme/demo/pulls/41/merge') {
        return { merged: true, sha: MERGED, message: 'Pull Request successfully merged' };
      }
      return undefined;
    };
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-b30-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repoRoot });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/demo.git'], { cwd: repoRoot });
    vi.stubEnv('CEZ_DRY_RUN', '0');
    // A caller's GH_HOST must not move any merge-path call off the PUT's host.
    vi.stubEnv('GH_HOST', 'ghe.example.internal');
    // Registered, with no `bootProjectId`: the boot context's own id is `default`, not the record's.
    projectId = (await registerProject(repoRoot)).id;
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    expect(gh.unhandled).toEqual([]);
  });

  const track = (url = URL) => {
    const path = projectImprovementRecordsPath(join(repoRoot, '.ai/cezar'));
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify([{
      id: 'i1', queue: 'project', projectId, startedBy: 'manager', startedAt: '2026-11-01T00:00:00.000Z',
      causeIds: [], state: 'pr-open', pr: { number: 41, url },
    }]));
    return path;
  };

  const merge = (method: string, scope = '') => apiRequest(app, `/api/v1${scope}/github/prs/41/merge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:4321' },
    body: JSON.stringify({ method, expectedHeadSha: HEAD }),
  });

  const put = (): string[] => {
    const found = gh.calls.find(({ argv }) => argv.includes('PUT'));
    if (!found) throw new Error('no merge PUT was sent');
    return found.argv;
  };
  const putFor = (method: string, ...title: string[]) => [
    'api', '--hostname', 'github.com', '--method', 'PUT', 'repos/acme/demo/pulls/41/merge',
    '-f', `merge_method=${method}`, '-f', `sha=${HEAD}`, ...title.map((t) => `commit_title=${t}`).flatMap((t) => ['-f', t]),
  ];

  it.each([['the scoped boot project', true], ['the unscoped compatibility route', false]])(
    'sends the fresh PR title as the exact squash subject and pins the reviewed head on %s', async (_label, scoped) => {
    const records = track();
    const response = await merge('squash', scoped ? `/p/${projectId}` : '');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ merged: true, number: 41, method: 'squash', mergeCommitSha: MERGED });
    expect(put()).toEqual(putFor('squash', 'Improve factory reliability (#41)'));
    expect(readImprovementRecords(records)).toMatchObject([{ state: 'merged', mergeCommit: MERGED }]);
  });

  it('reads title, eligibility and head from the PUT\'s repository and host, not gh\'s defaults', async () => {
    track();
    expect((await merge('squash')).status).toBe(200);
    const views = gh.calls.filter(({ argv }) => argv[0] === 'pr' && argv[1] === 'view');
    const apis = gh.calls.filter(({ argv }) => argv[0] === 'api');
    expect(views.length).toBeGreaterThan(0);
    expect(apis.length).toBeGreaterThan(4); // policy, two protection reads, rules, the PUT
    for (const { argv } of views) expect(argv.slice(2, 5)).toEqual(['41', '--repo', 'github.com/acme/demo']);
    for (const { argv } of apis) expect(argv.slice(1, 3)).toEqual(['--hostname', 'github.com']);
  });

  it('takes the title GitHub reports at merge time, not one read earlier', async () => {
    track();
    title = 'Old title';
    const state = await apiRequest(app, '/api/v1/github/prs/41/merge-state?refresh=1');
    expect(await state.json()).toMatchObject({ mergeState: { title: 'Old title' } });
    title = 'Renamed before merge';
    expect((await merge('squash')).status).toBe(200);
    expect(put()).toEqual(putFor('squash', 'Renamed before merge'));
  });

  it('ignores an open improvement with the same number in another repository', async () => {
    const records = track(OTHER_URL);
    expect((await merge('squash')).status).toBe(200);
    expect(put()).toEqual(putFor('squash'));
    expect(readImprovementRecords(records)).toMatchObject([{ state: 'pr-open' }]);
  });

  it('leaves an ordinary PR squash to GitHub\'s own subject', async () => {
    expect((await merge('squash')).status).toBe(200);
    expect(put()).toEqual(putFor('squash'));
  });

  it('never sets a title on a tracked improvement merged without squashing', async () => {
    track();
    expect((await merge('merge')).status).toBe(200);
    expect(put()).toEqual(putFor('merge'));
  });

  it('refuses a request body that tries to set the title flag itself', async () => {
    const response = await apiRequest(app, '/api/v1/github/prs/41/merge', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:4321' },
      body: JSON.stringify({ method: 'squash', expectedHeadSha: HEAD, squashSubjectFromPrTitle: true }),
    });
    expect(response.status).toBe(400);
    expect(gh.calls).toEqual([]);
  });
});
