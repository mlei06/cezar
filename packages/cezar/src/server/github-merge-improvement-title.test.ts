import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectImprovementRecordsPath, readImprovementRecords } from '../improvement/bookkeeping.ts';
import { registerProject } from '../workspace/projects.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

const HEAD = '0123456789abcdef0123456789abcdef01234567';
const MERGED = 'fedcba9876543210fedcba9876543210fedcba98';
const URL = 'https://github.com/acme/demo/pull/41';

// A stand-in `gh`: answers the merge-state reads, logs every argv, and merges on the PUT.
const FAKE_GH = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\\n');
const out = (value) => { process.stdout.write(JSON.stringify(value)); process.exit(0); };
if (args[0] === 'pr' && args[1] === 'view' && args.includes('statusCheckRollup')) out({ statusCheckRollup: [] });
if (args[0] === 'pr' && args[1] === 'view') out({
  number: 41, title: 'Improve factory reliability (#41)', url: '${URL}', state: 'OPEN', isDraft: false,
  headRefName: 'cez/abc12345', baseRefName: 'main', headRefOid: '${HEAD}',
  mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: '',
});
if (args[0] === 'api' && args[1] === 'repos/acme/demo') out({
  allow_squash_merge: true, allow_merge_commit: true, allow_rebase_merge: true,
  squash_merge_commit_title: 'COMMIT_OR_PR_TITLE',
});
if (args[0] === 'api' && args.includes('PUT')) out({ merged: true, sha: '${MERGED}', message: 'Pull Request successfully merged' });
process.stderr.write('gh: Not Found (HTTP 404)\\n');
process.exit(1);
`;

describe('B30: a tracked improvement squash-merges under its PR title', () => {
  let repoRoot: string;
  let bin: string;
  let log: string;
  let store: RunStore;
  let app: Hono;
  let projectId: string;

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-b30-'));
    bin = mkdtempSync(join(tmpdir(), 'cez-b30-bin-'));
    log = join(bin, 'argv.log');
    writeFileSync(join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repoRoot });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/demo.git'], { cwd: repoRoot });
    vi.stubEnv('CEZ_DRY_RUN', '0');
    vi.stubEnv('FAKE_GH_LOG', log);
    vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH ?? ''}`);
    // Registered, with no `bootProjectId`: the boot context's own id is `default`, not the record's.
    projectId = (await registerProject(repoRoot)).id;
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  });

  const track = () => {
    const path = projectImprovementRecordsPath(join(repoRoot, '.ai/cezar'));
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify([{
      id: 'i1', queue: 'project', projectId, startedBy: 'manager', startedAt: '2026-11-01T00:00:00.000Z',
      causeIds: [], state: 'pr-open', pr: { number: 41, url: URL },
    }]));
    return path;
  };

  const merge = (method: string, scope = '') => apiRequest(app, `/api/v1${scope}/github/prs/41/merge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:4321' },
    body: JSON.stringify({ method, expectedHeadSha: HEAD, overrideRules: true }),
  });

  const put = (): string[] => {
    const calls = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]);
    const found = calls.find((args) => args.includes('PUT'));
    if (!found) throw new Error('no merge PUT was sent');
    return found;
  };

  it.each([['the scoped boot project', true], ['the unscoped compatibility route', false]])(
    'sends the fresh PR title as the exact squash subject and pins the reviewed head on %s', async (_label, scoped) => {
    const records = track();
    const response = await merge('squash', scoped ? `/p/${projectId}` : '');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ merged: true, number: 41, method: 'squash', mergeCommitSha: MERGED });
    expect(put()).toEqual([
      'api', '--method', 'PUT', 'repos/acme/demo/pulls/41/merge',
      '-f', 'merge_method=squash', '-f', `sha=${HEAD}`,
      '-f', 'commit_title=Improve factory reliability (#41)',
    ]);
    expect(readImprovementRecords(records)).toMatchObject([{ state: 'merged', mergeCommit: MERGED }]);
  });

  it('leaves an ordinary PR squash to GitHub\'s own subject', async () => {
    expect((await merge('squash')).status).toBe(200);
    expect(put()).toEqual([
      'api', '--method', 'PUT', 'repos/acme/demo/pulls/41/merge',
      '-f', 'merge_method=squash', '-f', `sha=${HEAD}`,
    ]);
  });

  it('never sets a title on a tracked improvement merged without squashing', async () => {
    track();
    expect((await merge('merge')).status).toBe(200);
    expect(put()).toEqual([
      'api', '--method', 'PUT', 'repos/acme/demo/pulls/41/merge',
      '-f', 'merge_method=merge', '-f', `sha=${HEAD}`,
    ]);
  });

  it('refuses a request body that tries to set the title flag itself', async () => {
    const response = await apiRequest(app, '/api/v1/github/prs/41/merge', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:4321' },
      body: JSON.stringify({ method: 'squash', expectedHeadSha: HEAD, squashSubjectFromPrTitle: true }),
    });
    expect(response.status).toBe(400);
  });
});
