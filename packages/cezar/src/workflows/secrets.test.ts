import { execFile, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildChildEnv } from '../core/agent-env.ts';
import { RunStore } from '../runs/store.ts';
import { SecretStore } from '../workspace/secrets.ts';
import { CHECK_CONTEXT_VARS, RunManager } from './run.ts';
import { workflowStepSchema, type WorkflowDef } from './types.ts';

// Secret fixtures assert exact check output; developer login profiles must not
// add stderr or alter cwd. Keep real Bash/stdio/env and production -lc behavior.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (file: string, args: readonly string[], options?: SpawnOptions) => actual.spawn(
      file,
      file === 'bash' && args[0] === '-lc' ? ['--noprofile', '--norc', ...args] : args,
      options ?? {},
    ),
  };
});

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * Project and workspace secrets reach CHECK steps only (spec 2026-10-10-project-secrets-vault-options,
 * superseding the `check-env` half of 2026-10-06-agentic-e2e-checks Phase 1).
 *
 * The old advice — export the e2e model key before starting cezar — put the key in
 * `process.env`, where `buildChildEnv`'s prefix matching handed `ANTHROPIC_API_KEY` to every
 * Claude Code session and silently switched it to API billing. These tests pin the replacement:
 * the check sees the value, no agent env can, and a failing check's output is scrubbed before it
 * becomes the next agent prompt.
 */
describe('project and workspace secrets in check steps', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let secrets: SecretStore;
  let stdinLog: string;
  let argsLog: string;
  /** Per test, so each case starts with no store of its own — `CEZ_HOME` is one sandbox for the
   *  whole vitest worker, and a shared id would let one case read the previous one's file. */
  let project: string;
  let scope: { kind: 'project'; projectId: string; root: string };
  const workspace = { kind: 'workspace' } as const;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-secrets-'));
    project = `secrets-${randomUUID()}`;
    scope = { kind: 'project', projectId: project, root: repoRoot };
    for (const key of ['CEZ_DRY_RUN', 'CEZ_MOCK_STDIN_FILE', 'CEZ_MOCK_ARGS_FILE', 'CEZ_OPENCODE_BIN', 'CEZ_REDACT_SECRETS']) savedEnv[key] = process.env[key];
    process.env.CEZ_DRY_RUN = '1';
    stdinLog = join(repoRoot, '.mock-stdin.ndjson');
    process.env.CEZ_MOCK_STDIN_FILE = stdinLog;
    argsLog = join(repoRoot, '.mock-args.ndjson');
    process.env.CEZ_MOCK_ARGS_FILE = argsLog;
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    secrets = new SecretStore(process.env, { keychain: async () => null });
    manager = new RunManager(store, repoRoot, { projectId: project, secrets });
  });

  afterEach(async () => {
    manager.dispose();
    // The workspace file is shared by every case in this worker: leave it as found.
    for (const name of Object.keys((await secrets.read(workspace)).values)) await secrets.unset(workspace, name);
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const settle = async (id: string): Promise<void> => {
    const terminal = new Set(['done', 'review', 'failed', 'cancelled']);
    const deadline = Date.now() + 25_000;
    while (!terminal.has(store.getRun(id)?.status ?? '')) {
      if (Date.now() > deadline) throw new Error('run did not finish in time');
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  const capturedPrompts = () => readFileSync(argsLog, 'utf8').trim().split('\n')
    .map((line) => JSON.parse(line) as string[])
    .filter((argv) => argv.includes('--append-system-prompt'))
    .map((argv) => argv[argv.indexOf('--append-system-prompt') + 1]!);

  const checkOutputs = (id: string): string[] =>
    readFileSync(join(repoRoot, '.ai/cezar/runs', `${id}.ndjson`), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; text?: string })
      .filter((event) => event.type === 'check-output')
      .map((event) => event.text ?? '');

  const notes = (id: string): string[] =>
    readFileSync(join(repoRoot, '.ai/cezar/runs', `${id}.ndjson`), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; message?: string })
      .filter((event) => event.type === 'note')
      .map((event) => event.message ?? '');

  const checkOnly = (command: string, extra: Partial<WorkflowDef['steps'][number]> = {}): WorkflowDef => ({
    name: 'implement-and-check',
    source: 'file',
    steps: [
      { id: 'implement', name: 'Implement', prompt: '{{task}}' },
      { id: 'verify', name: 'Verify', command, ...extra },
    ],
  });

  it('hands a stored project secret to the check step', async () => {
    await secrets.set(scope, 'E2E_FLAG', 'on');
    const record = manager.startRun(checkOnly('echo "flag=$E2E_FLAG"'), { task: 'mock:done go', worktree: false });
    await settle(record.id);

    expect(store.getRun(record.id)?.status).toBe('done');
    expect(checkOutputs(record.id)).toEqual(['flag=on']);
  }, 30_000);

  it('hands a workspace secret too, the project\'s winning on a shared name, and withholds other audiences', async () => {
    // Short values on purpose: anything at or above `MIN_SECRET_LEN` is redacted from the transcript
    // this test reads back (pinned below, in the scrubbing case).
    await secrets.set(workspace, 'SHARED', 'from-ws');
    await secrets.set(workspace, 'WS_ONLY', 'ws-only');
    await secrets.set(workspace, 'LLM_KEY', 'cezar-only-key-value', ['cezar']);
    await secrets.set(scope, 'SHARED', 'from-proj');
    const record = manager.startRun(checkOnly('echo "$SHARED/$WS_ONLY/${LLM_KEY:-unset}"'), { task: 'mock:done go', worktree: false });
    await settle(record.id);

    expect(checkOutputs(record.id)).toEqual(['from-proj/ws-only/unset']);
  }, 30_000);

  it('honours the step\'s secrets: binding — exactly those, renamed on request, the rest said on the step', async () => {
    await secrets.set(scope, 'E2E_KEY', 'bound-key');
    await secrets.set(scope, 'OTHER', 'not-bound-value');
    await secrets.set(scope, 'LLM_KEY', 'cezar-only-key-value', ['cezar']);
    const record = manager.startRun(
      checkOnly('echo "${AI_GATEWAY_API_KEY:-unset}/${E2E_KEY:-unset}/${OTHER:-unset}/${LLM_KEY:-unset}"', {
        secrets: [{ name: 'E2E_KEY', as: 'AI_GATEWAY_API_KEY' }, 'LLM_KEY', 'MISSING'],
      }),
      { task: 'mock:done go', worktree: false },
    );
    await settle(record.id);

    expect(checkOutputs(record.id)).toEqual(['bound-key/unset/unset/unset']);
    expect(notes(record.id)).toEqual(expect.arrayContaining([
      'secret LLM_KEY is not available to checks (audiences: cezar)',
      'secret MISSING is not stored for this project or workspace',
    ]));
  }, 30_000);

  it('accepts agent secret names and empty lists while preserving check binding validation', () => {
    expect(workflowStepSchema.safeParse({ id: 'verify', command: 'true', secrets: ['E2E_KEY'] }).success).toBe(true);
    const agent = { id: 'implement', prompt: '{{task}}' };
    expect(workflowStepSchema.safeParse({ ...agent, secrets: ['E2E_KEY'] }).success).toBe(true);
    expect(workflowStepSchema.safeParse({ ...agent, secrets: [] }).success).toBe(true);
    expect(workflowStepSchema.safeParse({ ...agent, secrets: [{ name: 'E2E_KEY', as: 'OTHER_KEY' }] }).success).toBe(false);
    expect(workflowStepSchema.safeParse({ id: 'verify', command: 'true', secrets: ['PATH'] }).success).toBe(false);
    expect(workflowStepSchema.safeParse({ id: 'verify', command: 'true', secrets: [] }).success).toBe(false);
  });

  it('hands agents-audience secrets to the agent step, never an agent login or a checks-only one', async () => {
    await secrets.set(scope, 'NODE_SSH_USER', 'deploy-user');
    await secrets.set(workspace, 'JENKINS_TOKEN', 'jenkins-token-value');
    await secrets.set(scope, 'ANTHROPIC_API_KEY', 'sk-ant-api03-agentloginagentloginagentlogin');
    await secrets.set(scope, 'CHECK_ONLY', 'check-only-value', ['checks']);
    const run = store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [{ id: 'work', name: 'work', kind: 'agent' }] });
    const agentEnv = (secretNames?: string[]) => manager['agentEnvForStep'](run.id, 'claude', { secretNames });
    const { env } = await agentEnv();
    expect(env).toMatchObject({ NODE_SSH_USER: 'deploy-user', JENKINS_TOKEN: 'jenkins-token-value' });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CHECK_ONLY).toBeUndefined();

    const restricted = (await agentEnv(['JENKINS_TOKEN', 'CHECK_ONLY', 'ANTHROPIC_API_KEY', 'MISSING_KEY'])).env;
    expect(restricted.JENKINS_TOKEN).toBe('jenkins-token-value');
    for (const name of ['NODE_SSH_USER', 'CHECK_ONLY', 'ANTHROPIC_API_KEY', 'MISSING_KEY']) {
      expect(restricted[name]).toBeUndefined();
    }
    const empty = (await agentEnv([])).env;
    expect(empty.NODE_SSH_USER).toBeUndefined();
    expect(empty.JENKINS_TOKEN).toBeUndefined();
  });

  it('applies each allowlist at agent launch and keeps check bindings independent', async () => {
    await secrets.set(scope, 'SHARED_KEY', 'fixture-value', ['agents', 'checks']);
    const launches: (string | undefined)[] = [];
    const resolveEnv = manager['agentEnvForStep'].bind(manager);
    manager['agentEnvForStep'] = async (...args) => {
      const profile = await resolveEnv(...args);
      launches.push(profile.env.SHARED_KEY);
      return profile;
    };
    const budget = { minutes: 5 };
    const record = manager.startRun({
      name: 'scoped',
      source: 'file',
      budget,
      steps: [
        { id: 'first', prompt: '{{task}}', secrets: ['SHARED_KEY'] },
        { id: 'second', prompt: '{{task}}', secrets: [] },
        { id: 'verify', command: 'test "$VERIFY_KEY" = fixture-value', secrets: [{ name: 'SHARED_KEY', as: 'VERIFY_KEY' }] },
      ],
    }, { task: 'mock:done go', worktree: false });
    await settle(record.id);

    expect(store.getRun(record.id)?.status).toBe('done');
    expect(launches).toEqual(['fixture-value', undefined]);
    const steps = store.getRun(record.id)?.steps;
    expect(steps?.[0]?.capabilityPrompt).toContain('  SHARED_KEY');
    expect(steps?.[1]?.capabilityPrompt).toContain('Workflow: scoped');
    expect(steps?.[1]?.capabilityPrompt).toContain('Secrets in your environment: none.');
    const prompts = capturedPrompts();
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain(steps![0]!.capabilityPrompt!);
    expect(prompts[1]).toContain(steps![1]!.capabilityPrompt!);
    expect(prompts[1]).not.toContain('SHARED_KEY');
    expect(prompts.join('\n')).not.toContain('fixture-value');
    store.flush();
    expect(RunStore.open(join(repoRoot, '.ai/cezar')).getRun(record.id)?.workflowDef?.budget).toEqual(budget);

    expect(manager.continueRun(record.id, { text: 'mock:done follow up' })).toEqual({ ok: true });
    await vi.waitFor(() => expect(launches).toHaveLength(3), { timeout: 10_000 });
    expect(launches[2]).toBeUndefined();
    await settle(record.id);
  }, 30_000);

  it('composes and snapshots effective capabilities on start and Continue', async () => {
    process.env.CEZ_REDACT_SECRETS = '0';
    await secrets.set(workspace, 'SHARED_KEY', 'workspace-fixture-value', ['agents'], 'Workspace description');
    await secrets.set(scope, 'SHARED_KEY', 'project-fixture-value', ['agents'], 'Project description');
    const description = 'Operator  metadata: check-fixture-value';
    await secrets.set(scope, 'OPERATOR_KEY', 'synthetic-operator-value', ['agents'], description);
    await secrets.set(scope, 'CHECK_ONLY', 'check-fixture-value', ['checks']);
    await secrets.set(scope, 'UNLISTED', 'unlisted-fixture-value', ['agents']);
    await secrets.set(scope, 'OPENAI_API_KEY', 'login-fixture-value', ['agents']);
    mkdirSync(join(repoRoot, '.ai/skills/fixture-skill'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai/skills/fixture-skill/SKILL.md'), [
      '---', 'name: fixture-skill', 'description: A fixture skill', '---', 'Fixture instructions.',
    ].join('\n'));

    const workflow: WorkflowDef = {
      name: 'capability-fixture',
      source: 'file',
      budget: { tokens: 300_000, minutes: 30 },
      steps: [
        { id: 'work', prompt: '{{task}}', skill: 'fixture-skill', secrets: ['SHARED_KEY', 'OPERATOR_KEY', 'CHECK_ONLY', 'OPENAI_API_KEY', 'MISSING'] },
        { id: 'verify', command: 'true' },
      ],
    };
    const instructions = 'Project instructions for capability fixture';
    const record = manager.startRun(workflow, { task: 'mock:done go', worktree: false, systemPrompt: instructions });
    await settle(record.id);

    const capabilityBlock = (prompt: string) => prompt.split('\n\n---\n\n').find((part) => part.startsWith('Workflow: capability-fixture'));
    const opening = capturedPrompts()[0]!;
    const block = capabilityBlock(opening);
    expect(block).toBeDefined();
    expect(opening).toContain(`${instructions}\n\n---\n\n${block}\n\n---\n\n`);
    expect(block?.split('\n').filter((line) => line.startsWith('  '))).toEqual([`  OPERATOR_KEY: ${description}`, '  SHARED_KEY: Project description']);
    expect(block).toContain('Workflow: capability-fixture (claude); budget 300000 tokens, 30 min active');
    expect(block).toContain('Other workflows in this project: ');
    expect(block).toContain('quick-task');
    expect(block).toContain('Attached skill: fixture-skill');
    expect(opening).not.toContain('project-fixture-value');
    expect(opening).not.toContain('synthetic-operator-value');
    store.flush();
    expect(RunStore.open(join(repoRoot, '.ai/cezar')).getRun(record.id)?.steps[0]?.capabilityPrompt).toBe(block);

    await secrets.describe(scope, 'SHARED_KEY', 'Updated project description');
    await secrets.unset(scope, 'OPERATOR_KEY');
    expect(manager.continueRun(record.id, { text: 'mock:done continue' })).toEqual({ ok: true });
    await vi.waitFor(() => {
      expect(capturedPrompts().map(capabilityBlock)).toContain(block?.replace(`  OPERATOR_KEY: ${description}\n`, '').replace('Project description', 'Updated project description'));
    }, { timeout: 10_000 });
    await settle(record.id);
  }, 30_000);

  it('refreshes actual OpenCode 1.x resume prompts after a vault grant is revoked', async () => {
    process.env.CEZ_OPENCODE_BIN = fileURLToPath(new URL('../core/__fixtures__/opencode/mock-opencode-serve.mjs', import.meta.url));
    const requestsLog = join(repoRoot, 'requests.ndjson');
    const resolveEnv = manager['agentEnvForStep'].bind(manager);
    manager['agentEnvForStep'] = async (...args) => {
      const profile = await resolveEnv(...args);
      profile.env.D3_MOCK_REQUESTS_FILE = requestsLog;
      return profile;
    };
    const value = 'synthetic-revoked-d3-credential';
    await secrets.set(scope, 'D3_REVOKED_KEY', value, ['agents'], 'Old description');
    const record = manager.startRun({
      name: 'native-resume',
      source: 'file',
      steps: [
        { id: 'work', prompt: '{{task}}', secrets: ['D3_REVOKED_KEY'] },
        { id: 'check', command: 'true' },
      ],
    }, { task: 'Start the fixture', runner: 'opencode', worktree: false });
    await settle(record.id);
    const requests = () => readFileSync(requestsLog, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line) as { method: string; url: string; text?: string; hasRevokedKey?: boolean });
    expect(requests()).toEqual([
      expect.objectContaining({ method: 'POST', hasRevokedKey: true, text: expect.stringContaining('  D3_REVOKED_KEY: Old description') }),
    ]);

    await secrets.set(scope, 'D3_REVOKED_KEY', value, ['checks']);
    expect(manager.continueRun(record.id, { text: 'Continue the fixture' })).toEqual({ ok: true });
    await vi.waitFor(() => expect(requests()).toHaveLength(3), { timeout: 10_000 });
    const [opening, reopen, resume] = requests();
    expect(reopen).toEqual({ method: 'GET', url: '/session/ses_mock_1' });
    expect(resume).toMatchObject({
      method: 'POST', url: '/session/ses_mock_1/message', hasRevokedKey: false,
      text: expect.stringContaining('Secrets in your environment: none.'),
    });
    expect(resume?.text).toContain('Continue the fixture');
    expect(resume?.text).not.toContain('D3_REVOKED_KEY');
    expect(resume?.text).not.toContain('Old description');
    expect(`${opening?.text}${resume?.text}`).not.toContain(value);
    expect(resume?.text).toContain(store.getRun(record.id)!.steps.at(-1)!.capabilityPrompt!);
    await vi.waitFor(() => expect(store.getRun(record.id)?.status).toBe('waiting'), { timeout: 10_000 });
  }, 30_000);

  it('never leaks a secret into the server process env', async () => {
    const key = 'sk-ant-api03-checkonlycheckonlycheckonly';
    await secrets.set(scope, 'ANTHROPIC_API_KEY', key);
    await secrets.set(scope, 'FOO', 'check-only-value');
    const record = manager.startRun(checkOnly('test "$FOO" = check-only-value'), {
      task: 'mock:done go',
      worktree: false,
    });
    await settle(record.id);

    // The check got both; the run passed only because `FOO` was there.
    expect(store.getRun(record.id)?.status).toBe('done');
    // The regression pin: nothing reached `process.env`, so no backend's prefix curation
    // (claude: ANTHROPIC_*, codex: OPENAI_*, opencode/pi: the multi-provider list) can pass it on.
    expect(process.env.ANTHROPIC_API_KEY).not.toBe(key);
    expect(process.env.FOO).toBeUndefined();
    for (const backend of ['claude', 'codex', 'opencode'] as const) {
      const env = buildChildEnv({ backend });
      expect(env.ANTHROPIC_API_KEY).not.toBe(key);
      expect(env.FOO).toBeUndefined();
    }
  }, 30_000);

  it('scrubs a failing check\'s output before it becomes the next agent prompt', async () => {
    const credential = 'e2e-credential-value-0123456789';
    const token = 'sk-ant-api03-leakedleakedleakedleaked';
    await secrets.set(scope, 'E2E_GATEWAY_KEY', credential);
    const workflow: WorkflowDef = {
      name: 'implement-and-check',
      source: 'file',
      steps: [
        { id: 'implement', name: 'Implement', prompt: '{{task}}' },
        {
          id: 'verify',
          name: 'Verify',
          command: `echo "auth failed with $E2E_GATEWAY_KEY and ${token}"; exit 1`,
          onFail: { retry: 'implement', max: 1 },
        },
      ],
    };
    const record = manager.startRun(workflow, { task: 'mock:done fix it', worktree: false });
    await settle(record.id);

    const prompts = readFileSync(stdinLog, 'utf8')
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { userText: string }).userText);
    const retried = prompts.find((text) => text.includes('A verification command failed'));
    expect(retried).toBeDefined();
    expect(retried).toContain('[REDACTED]');
    expect(retried).not.toContain(credential);
    expect(retried).not.toContain(token);
  }, 40_000);

  it('without a secret store the check runs with the server env, unchanged', async () => {
    process.env.CEZ_GUARD_PROBE_FOR_CHECKS = 'server-value';
    try {
      const record = manager.startRun(checkOnly('echo "$CEZ_GUARD_PROBE_FOR_CHECKS"'), {
        task: 'mock:done go',
        worktree: false,
      });
      await settle(record.id);
      expect(store.getRun(record.id)?.status).toBe('done');
      expect(checkOutputs(record.id)).toEqual(['server-value']);
      // Nothing stored is the ordinary case: it degrades silently, with no note to explain.
      expect(notes(record.id).filter((note) => note.includes('secret'))).toEqual([]);
    } finally {
      delete process.env.CEZ_GUARD_PROBE_FOR_CHECKS;
    }
  }, 30_000);

  it('says so on the step when it found a store it could not use', async () => {
    // A store written for a DIFFERENT project root — a moved checkout, a changed symlink. It
    // reads as empty by design, and the value is write-only, so without this note the user sees
    // an empty `secrets list` and cannot tell "never stored" from "stored but ignored".
    const elsewhere = mkdtempSync(join(tmpdir(), 'cez-secrets-elsewhere-'));
    try {
      await secrets.set({ ...scope, root: elsewhere }, 'E2E_FLAG', 'on');
      const record = manager.startRun(checkOnly('echo "flag=$E2E_FLAG"'), { task: 'mock:done go', worktree: false });
      await settle(record.id);

      expect(store.getRun(record.id)?.status).toBe('done');
      expect(checkOutputs(record.id)).toEqual(['flag=']);
      expect(notes(record.id).some((note) => /project secrets skipped — the store belongs to another project root/.test(note))).toBe(true);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  }, 30_000);
});

/**
 * The run context a check step gets (spec 2026-10-06-agentic-e2e-checks Phase 2): what it is
 * verifying, where, which attempt this is, and a cache shared across the project's worktrees.
 */
describe('run context for check steps', () => {
  const PROJECT = 'check-context-project';
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-check-context-'));
    for (const key of ['CEZ_DRY_RUN', 'CEZ_RUN_ID', 'CEZ_GITHUB_NUMBER', 'CEZ_PROJECT_ID']) savedEnv[key] = process.env[key];
    process.env.CEZ_DRY_RUN = '1';
    // What a cezar started inside another cezar task inherits: it must never leak through.
    process.env.CEZ_RUN_ID = 'outer-task';
    process.env.CEZ_GITHUB_NUMBER = '999';
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot, { projectId: PROJECT });
  });

  afterEach(() => {
    manager.dispose();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const contextOf = (runId: string, stepId: string, cwd: string) =>
    (manager as unknown as {
      checkStepEnv(runId: string, state: { cwd: string }, step: { id: string }, emit: () => void): Promise<NodeJS.ProcessEnv>;
    }).checkStepEnv(runId, { cwd }, { id: stepId }, () => undefined);

  it.each([false, true])('strips inherited tracker capability from checks (untrustedHead=%s)', async untrustedHead => {
    const names = ['CEZ_TRACKER_CAPABILITY', 'cez_tracker_capability', 'NORMAL_HOST_SETTING'];
    const previous = names.map(name => process.env[name]);
    try {
      process.env.CEZ_TRACKER_CAPABILITY = 'parent-task-grant';
      process.env.cez_tracker_capability = 'mixed-case-parent-grant';
      process.env.NORMAL_HOST_SETTING = 'preserve-check-env';
      const record = store.createRun({ title: 't', workflow: 'w', task: 'x', steps: [{ id: 'verify', name: 'Verify', kind: 'check' }] });
      store.updateRun(record.id, { untrustedHead });
      const env = await contextOf(record.id, 'verify', repoRoot);
      expect(env).not.toHaveProperty('CEZ_TRACKER_CAPABILITY');
      expect(env).not.toHaveProperty('cez_tracker_capability');
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.NORMAL_HOST_SETTING).toBe('preserve-check-env');
      expect(env.CEZ_RUN_ID).toBe(record.id);
      expect(process.env.CEZ_TRACKER_CAPABILITY).toBe('parent-task-grant');
    } finally {
      names.forEach((name, index) => {
        if (previous[index] === undefined) delete process.env[name];
        else process.env[name] = previous[index];
      });
    }
  });

  it('sets every run variable on a worktree run, and nothing GitHub- or PR-only', async () => {
    const record = manager.startRun(
      {
        name: 'implement-and-check',
        source: 'file',
        steps: [
          { id: 'implement', name: 'Implement', prompt: '{{task}}' },
          { id: 'verify', name: 'Verify', command: 'env | grep "^CEZ_" | sort > "$CEZ_WORKTREE/../check-env.txt"' },
        ],
      },
      { task: 'mock:done go' },
    );
    const terminal = new Set(['done', 'review', 'failed', 'cancelled']);
    const deadline = Date.now() + 25_000;
    while (!terminal.has(store.getRun(record.id)?.status ?? '')) {
      if (Date.now() > deadline) throw new Error('run did not finish in time');
      await new Promise((r) => setTimeout(r, 100));
    }
    const finished = store.getRun(record.id)!;
    expect(['done', 'review']).toContain(finished.status);
    const seen = Object.fromEntries(
      readFileSync(join(finished.worktreePath!, '..', 'check-env.txt'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
    expect(seen).toMatchObject({
      CEZ_RUN_ID: record.id,
      CEZ_PROJECT_ID: PROJECT,
      CEZ_WORKTREE: finished.worktreePath,
      CEZ_BRANCH: finished.branch,
      CEZ_BASE: finished.baseBranch,
      CEZ_STEP_ID: 'verify',
      CEZ_ATTEMPT: '1',
    });
    expect(seen.CEZ_SHARED_CACHE_DIR).toBe(join(process.env.CEZ_HOME!, 'cache', PROJECT));
    // Absent, not empty — including the stale values this process inherited. Driven off
    // `CHECK_CONTEXT_VARS` rather than a second hand-written list, so a name added to the strip
    // list without a value cannot quietly stop being asserted here.
    const expected = new Set(Object.keys(seen));
    for (const name of CHECK_CONTEXT_VARS) {
      if (expected.has(name)) continue;
      expect(seen).not.toHaveProperty(name);
    }
    for (const name of ['CEZ_GITHUB_REPO', 'CEZ_GITHUB_NUMBER', 'CEZ_GITHUB_EVENT', 'CEZ_PR_HEAD_SHA', 'CEZ_PR_HEAD_REF', 'CEZ_PR_BASE_REF']) {
      expect(seen).not.toHaveProperty(name);
    }
  }, 40_000);

  /**
   * `CEZ_PROJECT_ID` is the one context name that is also a documented CLI *input*
   * (BACKWARD_COMPATIBILITY.md §1 — it is how `cez task`/`cez automation` address a cockpit), so
   * the strip must not reach it on a run that cannot replace it. The headless `cezar run` path
   * builds its manager without a projectId; stripping there left `CEZ_API_URL` in place while
   * `cez task create` silently fell back to the cockpit's boot project.
   */
  it('forwards an inherited CEZ_PROJECT_ID when the run has no project of its own', async () => {
    process.env.CEZ_PROJECT_ID = 'operators-choice';
    const projectless = new RunManager(store, repoRoot);
    try {
      const record = store.createRun({ title: 't', workflow: 'w', task: 'x', steps: [{ id: 'verify', name: 'Verify', kind: 'check' }] });
      const env = await (projectless as unknown as {
        checkStepEnv(runId: string, state: { cwd: string }, step: { id: string }, emit: () => void): Promise<NodeJS.ProcessEnv>;
      }).checkStepEnv(record.id, { cwd: repoRoot }, { id: 'verify' }, () => undefined);
      expect(env.CEZ_PROJECT_ID).toBe('operators-choice');
      // No project means no per-project cache, and the run's own ids still replace the inherited
      // ones — the forwarding is the single exception, not a hole in the strip.
      expect(env).not.toHaveProperty('CEZ_SHARED_CACHE_DIR');
      expect(env.CEZ_RUN_ID).toBe(record.id);
    } finally {
      projectless.dispose();
    }
  });

  it('replaces an inherited CEZ_PROJECT_ID when the run does have a project', async () => {
    process.env.CEZ_PROJECT_ID = 'operators-choice';
    const record = store.createRun({ title: 't', workflow: 'w', task: 'x', steps: [{ id: 'verify', name: 'Verify', kind: 'check' }] });
    expect((await contextOf(record.id, 'verify', repoRoot)).CEZ_PROJECT_ID).toBe(PROJECT);
  });

  /**
   * The id becomes a path segment, so it is re-validated where that happens — the same guard
   * `workspace/secrets.ts` applies before building `~/.cezar/secrets/<projectId>.json`. No
   * caller can produce this id today (the workspace schema drops it, `allocateProjectSlug`
   * cannot emit it); the point is that a `recursive` mkdir is not where we want to find out.
   */
  it('omits the cache directory rather than escaping the cezar home on a non-slug project id', async () => {
    const record = store.createRun({ title: 't', workflow: 'w', task: 'x', steps: [{ id: 'verify', name: 'Verify', kind: 'check' }] });
    const escaping = new RunManager(store, repoRoot, { projectId: '../../escape' });
    try {
      const env = await (escaping as unknown as {
        checkStepEnv(runId: string, state: { cwd: string }, step: { id: string }, emit: () => void): Promise<NodeJS.ProcessEnv>;
      }).checkStepEnv(record.id, { cwd: repoRoot }, { id: 'verify' }, () => undefined);
      expect(env).not.toHaveProperty('CEZ_SHARED_CACHE_DIR');
    } finally {
      escaping.dispose();
    }
  });

  it('adds the GitHub provenance of an automation run', async () => {
    const record = store.createRun({ title: 't', workflow: 'w', task: 'x', steps: [{ id: 'verify', name: 'Verify', kind: 'check' }] });
    store.updateRun(record.id, {
      automation: {
        automationId: 'a1',
        automationRevision: 1,
        receiptId: 'r1',
        event: 'pull_request.opened',
        githubUrl: 'https://github.com/acme/shop/pull/42',
      },
    });
    const env = await contextOf(record.id, 'verify', repoRoot);
    expect(env).toMatchObject({ CEZ_GITHUB_REPO: 'acme/shop', CEZ_GITHUB_NUMBER: '42', CEZ_GITHUB_EVENT: 'pull_request.opened' });
    expect(env).not.toHaveProperty('CEZ_BRANCH');
  });

  it('counts the attempt from the step\'s own iterations', async () => {
    const record = store.createRun({ title: 't', workflow: 'w', task: 'x', steps: [{ id: 'verify', name: 'Verify', kind: 'check' }] });
    store.updateStep(record.id, 'verify', { iterations: 3 });
    expect((await contextOf(record.id, 'verify', repoRoot)).CEZ_ATTEMPT).toBe('3');
  });

  it('shares one 0700 cache directory per project, and a different one per project', async () => {
    const record = store.createRun({ title: 't', workflow: 'w', task: 'x', steps: [{ id: 'verify', name: 'Verify', kind: 'check' }] });
    const first = (await contextOf(record.id, 'verify', repoRoot)).CEZ_SHARED_CACHE_DIR!;
    const second = (await contextOf(record.id, 'verify', repoRoot)).CEZ_SHARED_CACHE_DIR!;
    expect(second).toBe(first);
    expect(statSync(first).mode & 0o777).toBe(0o700);
    const other = new RunManager(store, repoRoot, { projectId: 'another-project' });
    try {
      const theirs = await (other as unknown as {
        checkStepEnv(runId: string, state: { cwd: string }, step: { id: string }, emit: () => void): Promise<NodeJS.ProcessEnv>;
      }).checkStepEnv(record.id, { cwd: repoRoot }, { id: 'verify' }, () => undefined);
      expect(theirs.CEZ_SHARED_CACHE_DIR).not.toBe(first);
    } finally {
      other.dispose();
    }
  });
});
