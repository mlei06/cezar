import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { smokeStagedHarness, withStagingCockpit } from './staging.ts';

// `outcome` stands in for what the engine records: the step outcome, and the exit its
// `check-output` event carries (-1 for a spawn failure or a signal; null for no event).
type Outcome = { status: string; error?: string; exitCode?: number | null };
const fixtureWith = (outcome: Outcome | 'run-command') => [
  "import { createServer } from 'node:http';",
  "const port = Number(process.argv[process.argv.indexOf('--port') + 1]);",
  "const run = { id: 'fixture', title: 'check', task: 'check', workflow: 'example',",
  "  createdAt: '2026-01-01T00:00:00.000Z', tokensUsed: 0, archived: false, steps: [] };",
  "let command = 'true';",
  "const outcome = " + JSON.stringify(outcome) + ";",
  "const step = (status, error) => ({ id: 'check', name: 'check', kind: 'check', status, iterations: 1, tokensUsed: 0, ...(error ? { error } : {}) });",
  "createServer(async (req, res) => {",
  "  if (req.method === 'POST') { let body = ''; for await (const chunk of req) body += chunk;",
  "    command = JSON.parse(body).steps[0].command; }",
  "  const failed = command !== 'true';",
  "  const result = outcome === 'run-command' ? (failed ? { status: 'failed', error: '`' + command + '` exited non-zero', exitCode: 1 } : { status: 'done', exitCode: 0 }) : outcome;",
  "  const exits = typeof result.exitCode === 'number' ? [{ seq: 1, ts: run.createdAt, type: 'check-output', stepId: 'check', command, text: '', exitCode: result.exitCode }] : [];",
  "  const payload = req.url === '/api/v1/health' ? { instanceId: process.env.CEZ_INSTANCE_ID }",
  "    : req.url === '/api/v1/runs/fixture/history' ? { events: exits, itemCount: exits.length, liveCursor: 'live', asOfSeq: 1, hasOlder: false }",
  "    : req.url === '/api/v1/isolated' ? { workspace: process.env.CEZ_HOME, cwd: process.cwd(),",
  "         runnerOverride: process.env.CEZ_OPENCODE_BIN, dry: process.env.CEZ_DRY_RUN, managers: process.env.CEZ_MANAGERS,",
  "         automations: process.env.CEZ_AUTOMATIONS, scoring: process.env.CEZ_SCORING, codexHome: process.env.CODEX_HOME }",
  "    : req.method === 'POST' ? { ...run, status: 'queued' }",
  "    : { ...run, status: result.status === 'done' ? 'done' : 'failed', steps: [step(result.status, result.error)] };",
  "  res.setHeader('content-type', 'application/json');",
  "  res.end(JSON.stringify(payload));",
  "}).listen(port, '127.0.0.1');",
].join('\n');
const fixture = fixtureWith('run-command');

it('starts an independent cockpit and removes its workspace after a failed check', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-staging-test-'));
  vi.stubEnv('CEZ_OPENCODE_BIN', 'example-runner-override');
  try {
    const entry = join(root, 'fixture.mjs');
    await writeFile(entry, fixture);
    await smokeStagedHarness(entry);
    let scratch: string | undefined;
    let api: string | undefined;
    const use = async (url: string) => {
      api = url;
      const { workspace, cwd, ...modes } = await fetch(api + '/isolated').then((response) => response.json()) as {
        workspace: string;
        cwd: string;
        dry: string;
        managers: string;
        automations: string;
      };
      scratch = dirname(workspace);
      expect(workspace).not.toBe(process.env.CEZ_HOME);
      expect(cwd).toBe(join(scratch, 'project'));
      expect(modes).toEqual({ dry: '1', managers: '0', automations: '0', scoring: '0' });
      await access(scratch);
      throw new Error('fixture failed');
    };
    await expect(withStagingCockpit(entry, use)).rejects.toThrow('fixture failed');
    expect(scratch).toBeDefined();
    await expect(access(scratch!)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fetch(api + '/health')).rejects.toThrow();
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);

it('fails the smoke task itself for the rollback drill', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-staging-test-'));
  try {
    const entry = join(root, 'fixture.mjs');
    await writeFile(entry, fixture);
    expect(await smokeStagedHarness(entry, { simulateFailure: true })).toEqual({
      simulatedFailure: { step: 'check', command: 'false', exitCode: 1, error: '`false` exited non-zero' },
    });
    await smokeStagedHarness(entry);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);

it.each([
  ['a failure outside the check', { status: 'failed', error: 'The worktree could not be created.' }, 'failed outside its check'],
  ['a drill task that passed', { status: 'done' }, 'The drill smoke task did not fail.'],
  ['a check that could not launch or was signalled', { status: 'failed', error: '`false` exited non-zero', exitCode: -1 },
    'did not record `false` exiting 1 (exit -1)'],
  ['a check that exited with another code', { status: 'failed', error: '`false` exited non-zero', exitCode: 2 },
    'did not record `false` exiting 1 (exit 2)'],
  ['a check without a recorded exit', { status: 'failed', error: '`false` exited non-zero', exitCode: null },
    'did not record `false` exiting 1 (exit unrecorded)'],
] as const)('treats %s in the drill as an ordinary smoke failure', async (_name, outcome, message) => {
  const root = await mkdtemp(join(tmpdir(), 'cez-staging-test-'));
  try {
    const entry = join(root, 'fixture.mjs');
    await writeFile(entry, fixtureWith(outcome));
    await expect(smokeStagedHarness(entry, { simulateFailure: true })).rejects.toThrow(message);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);

it('reports a drill that never got a staging cockpit as an ordinary failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-staging-test-'));
  try {
    const entry = join(root, 'fixture.mjs');
    await writeFile(entry, 'process.exit(3);');
    await expect(smokeStagedHarness(entry, { simulateFailure: true })).rejects.toThrow('The staging cockpit exited during startup.');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);

it('passes only the selected Codex home to an authenticated staging replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-staging-test-'));
  const codexHome = join(root, 'selected-profile');
  vi.stubEnv('CODEX_HOME', join(root, 'different-profile'));
  vi.stubEnv('CEZ_OPENCODE_BIN', 'example-runner-override');
  vi.stubEnv('CEZ_SCORING', '1');
  try {
    const entry = join(root, 'fixture.mjs');
    await writeFile(entry, fixture);
    const modes = await withStagingCockpit(entry, async (api) =>
      fetch(api + '/isolated').then((response) => response.json()), { dryRun: false, codexHome });
    expect(modes).toMatchObject({ dry: '0', managers: '0', automations: '0', scoring: '0', codexHome });
    expect(modes).not.toHaveProperty('runnerOverride');
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);
