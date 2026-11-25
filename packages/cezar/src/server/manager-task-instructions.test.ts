import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunSpec, AgentSession } from '../core/agent-runner.ts';
import { ClaudeCliRunner } from '../core/claude-cli-runner.ts';
import { CodexAppServerRunner } from '../core/codex-app-server-runner.ts';
import { runManagerCommand } from '../managers/manager-cli.ts';
import { RunnerModelCatalog } from '../core/runner-model-catalog.ts';
import { mergeWriteAgentAccounts } from '../workspace/agent-accounts.ts';
import { registerProject } from '../workspace/projects.ts';
import { SecretStore } from '../workspace/secrets.ts';
import type { ManagerEngine } from '../managers/engine.ts';
import { RunStore } from '../runs/store.ts';
import { mergeWriteWorkspaceConfig } from '../workspace/config.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { composeDispatchPrompt } from '../dispatch/prompts.ts';
import { RunManager } from '../workflows/run.ts';
import * as pullRequests from './pr.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

const GLOBAL = 'Do not run the full test suite. Run only focused tests.';
const PROJECT = 'Keep the project API compatible.';
const SKILL = 'Inspect the changed module before editing.';
const GUARD = 'Do not merge pull requests or enable automations';
const BASE = '/api/v1/workspace/managers';

describe('manager task instruction propagation through the HTTP API and workflow engine', () => {
  let root: string;
  let store: RunStore;
  let runs: RunManager;
  let engine: ManagerEngine;
  let app: ReturnType<typeof createApp>;
  let specs: AgentRunSpec[];
  let semaphore: WorkspaceSemaphore;
  let bootProjectId: string;
  let sessions: AgentSession[];

  const request = (path: string, body: unknown) => app.request(path, {
    method: 'POST', headers: { 'content-type': 'application/json', host: '127.0.0.1' }, body: JSON.stringify(body),
  });

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cez-manager-instructions-'));
    vi.stubEnv('CEZ_HOME', join(root, 'home'));
    vi.stubEnv('CEZ_DRY_RUN', '1');
    vi.stubEnv('CEZ_SINGLE_PROJECT', '0');
    vi.stubEnv('CEZ_AUTONAME', '0');
    vi.stubEnv('CEZ_DISPATCH', '1');
    vi.stubEnv('CEZ_API_URL', 'http://127.0.0.1:4399');
    vi.stubEnv('CEZ_AUTOMATIONS', '0');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, timeout: 10_000 });
    writeFileSync(join(root, 'file.txt'), 'base\n');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --version' } }));
    execFileSync('git', ['add', 'file.txt', 'package.json'], { cwd: root, timeout: 10_000 });
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-qm', 'base'], { cwd: root, timeout: 10_000 });
    mkdirSync(join(root, '.ai/cezar/workflows'), { recursive: true });
    mkdirSync(join(root, '.ai/skills/instruction-check'), { recursive: true });
    writeFileSync(join(root, '.ai/skills/instruction-check/SKILL.md'), `---\nname: instruction-check\n---\n${SKILL}\n`);
    writeFileSync(join(root, '.ai/cezar/config.json'), JSON.stringify({ systemPrompt: PROJECT, skillsRepos: [] }));
    writeFileSync(join(root, '.ai/cezar/workflows/instructions.yaml'), [
      'name: instructions', 'steps:', '  - id: first', '    skill: instruction-check', '    prompt: "{{task}}"',
      '    runner: codex', '  - id: second', '    prompt: "{{task}}"', '    runner: claude',
      '  - id: verify', '    command: "true"',
    ].join('\n'));
    await mergeWriteWorkspaceConfig((config) => { config.systemPrompt = GLOBAL; });
    specs = [];
    sessions = [];
    for (const prototype of [ClaudeCliRunner.prototype, CodexAppServerRunner.prototype]) {
      const start = prototype.startSession;
      vi.spyOn(prototype, 'startSession').mockImplementation(function (this: typeof prototype, ...args) {
        specs.push(args[0]);
        const session = start.apply(this, args);
        sessions.push(session);
        return session;
      });
    }
    store = RunStore.open(join(root, '.ai/cezar'));
    bootProjectId = (await registerProject(root)).id;
    const secrets = new SecretStore(process.env, { keychain: async () => null });
    semaphore = new WorkspaceSemaphore({ initial: { maxParallel: 2 } });
    const modelCatalog = new RunnerModelCatalog({ adapters: {
      codex: { discover: async () => [{
        id: 'gpt-5.1-codex', label: 'Codex fixture', description: '',
        reasoningEfforts: [{ id: 'low', description: '' }, { id: 'high', description: '' }],
      }] },
    } });
    runs = new RunManager(store, root, { projectId: bootProjectId, secrets, semaphore });
    app = createApp({ repoRoot: root, version: 'test', store, manager: runs, bootProjectId, secrets, semaphore, modelCatalog, onManagerEngine: (built) => { engine = built; } });
  });

  afterEach(async () => {
    try {
      await engine.shutdown();
      for (const run of store.listRuns()) runs.cancel(run.id);
      runs.dispose();
      for (const session of sessions) session.interrupt();
      await Promise.allSettled(sessions.map((session) => session.result));
      store.flush();
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  async function createTask(workflow: string, runner: 'claude' | 'codex', text = 'Fix the module mock:done') {
    const created = await request(BASE, { instructions: 'Help with tasks', projects: 'all', cronMinutes: 0 });
    expect(created.status).toBe(201);
    const manager = await created.json() as { id: string; connectedProjectIds: string[] };
    await engine.update(manager.id, { followUp: false, notify: false });
    const projectId = manager.connectedProjectIds[0];
    const response = await request(`${BASE}/${manager.id}/tasks`, { projectId, task: text, workflow, runner });
    expect(response.status).toBe(201);
    const task = await response.json() as { runId: string };
    return { ...task, managerId: manager.id, projectId };
  }

  it('discovers task capabilities and applies CLI overrides through the manager and run APIs', async () => {
    writeFileSync(join(root, '.ai/cezar/workflows/override.yaml'), [
      'name: override', 'budget: { tokens: 500, minutes: 20 }', 'steps:',
      '  - id: agent', '    runner: claude', '    model: sonnet',
      '    secrets: [WORKFLOW_TOKEN]', '    prompt: "{{task}}"',
    ].join('\n'));
    const managerOnly = join(process.env.CEZ_HOME!, 'manager-skills', 'private-playbook');
    mkdirSync(managerOnly, { recursive: true });
    writeFileSync(join(managerOnly, 'SKILL.md'), '---\nname: private-playbook\n---\nManager playbook');
    symlinkSync(managerOnly, join(root, '.ai/skills/private-playbook'), process.platform === 'win32' ? 'junction' : 'dir');

    const outside = join(root, 'outside');
    mkdirSync(outside);
    execFileSync('git', ['init', '-q'], { cwd: outside, timeout: 10_000 });
    const outsideProject = await registerProject(outside);
    const profile = (id: string) => ({ id, provider: 'codex' as const, label: id, configDir: root, addedAt: '' });
    await mergeWriteAgentAccounts((settings) => ({ ...settings, accounts: [profile('held'), profile('deleted')] }));
    const created = await request(BASE, {
      instructions: 'Help with tasks', projects: [bootProjectId], cronMinutes: 0,
      taskAgents: [{ runner: 'claude', agentProfile: 'default' },
        { runner: 'codex', agentProfile: 'held' }, { runner: 'codex', agentProfile: 'deleted' }],
    });
    expect(created.status).toBe(201);
    const manager = await created.json() as { id: string; connectedProjectIds: string[] };
    expect(manager.connectedProjectIds).toEqual([bootProjectId]);
    await engine.update(manager.id, { followUp: false, notify: false });
    await mergeWriteAgentAccounts((settings) => ({ ...settings, accounts: [profile('held')] }));
    const until = Date.now() + 120_000;
    vi.spyOn(semaphore, 'accountHolds').mockReturnValue({
      deadlines: new Map([['codex:held', until]]), deadline: new Set(['codex:held']), inFlight: new Set(),
    });
    const projectId = bootProjectId;
    const prefix = `/api/v1/p/${projectId}`;
    for (const [path, description, audiences] of [
      [`${prefix}/secrets/CLI_TOKEN`, 'Task test token', ['agents']],
      ['/api/v1/workspace/secrets/WORKFLOW_TOKEN', 'Workflow token', ['agents']],
      ['/api/v1/workspace/secrets/CHECK_TOKEN', 'Check token', ['checks']],
      ['/api/v1/workspace/secrets/SHADOWED_TOKEN', 'Workspace agent token', ['agents']],
      [`${prefix}/secrets/SHADOWED_TOKEN`, 'Project check token', ['checks']],
    ] as const) {
      const response = await apiRequest(app, path, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: 'synthetic-value-123', description, audiences }),
      });
      expect(response.status).toBe(204);
    }

    const cli = async (args: string[], status = 0) => {
      const output: string[] = [];
      const errors: string[] = [];
      const code = await runManagerCommand(args, { CEZ_API_URL: 'http://127.0.0.1:4399', CEZ_MANAGER_ID: manager.id }, {
        fetch: (input, init) => {
          const url = new URL(String(input));
          return apiRequest(app, url.pathname + url.search, init);
        },
        log: (line) => output.push(line), error: (line) => errors.push(line),
      });
      expect(code, errors.join('\n')).toBe(status);
      return output.join('\n');
    };
    const flags = ['--project', projectId, '--json'];
    const secretJson = await cli(['secrets', ...flags]);
    expect(secretJson).not.toContain('synthetic-value-123');
    expect(JSON.parse(secretJson).secrets).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'CLI_TOKEN', description: 'Task test token', audiences: ['agents'], scope: 'project' }),
      expect.objectContaining({ name: 'WORKFLOW_TOKEN', scope: 'workspace' }),
    ]));
    const skills = JSON.parse(await cli(['skills', ...flags])).skills;
    expect(skills.map((skill: { name: string }) => skill.name)).toContain('instruction-check');
    expect(skills.map((skill: { name: string }) => skill.name)).not.toContain('private-playbook');
    expect(JSON.parse(await cli(['models', ...flags, '--runner', 'codex'])).catalogs).toEqual([
      expect.objectContaining({ runner: 'codex', models: [expect.objectContaining({
        id: 'gpt-5.1-codex', reasoningEfforts: [expect.objectContaining({ id: 'low' }), expect.objectContaining({ id: 'high' })],
      })] }),
    ]);
    expect(await cli(['models', '--runner', 'codex', '--project', projectId])).toContain('codex  gpt-5.1-codex  low, high');
    expect(JSON.parse(await cli(['models', ...flags, '--runner', 'gemini'])).catalogs).toEqual([
      expect.objectContaining({ runner: 'gemini', source: 'presets', models: expect.arrayContaining([
        expect.objectContaining({ id: 'gemini-3.5-flash' }),
      ]) }),
    ]);
    expect(await cli(['models', '--runner', 'gemini', '--project', projectId])).toContain('gemini  gemini-3.5-flash  -');
    expect(await cli(['models', '--runner', 'claude', '--project', projectId])).toContain('claude  sonnet  low, medium, high, max');
    expect(await cli(['models', '--runner', 'pi', '--project', projectId])).toContain('pi  no model catalog');
    expect(JSON.parse(await cli(['agents', ...flags])).accounts).toEqual([
      { runner: 'claude', agentProfile: 'default', account: 'default', label: 'default account' },
      { runner: 'codex', agentProfile: 'held', account: 'held', label: 'held', outOfLimitsUntil: new Date(until).toISOString() },
    ]);
    expect(await cli(['agents', '--project', projectId])).toContain(`codex  held  held  out of limits until ${new Date(until).toISOString()}`);
    expect(await cli(['workflows', '--project', projectId])).toMatch(/override.*model: claude\/sonnet.*500 tokens, 20 min/);
    expect(JSON.parse(await cli(['workflows', ...flags])).workflows).toContainEqual(expect.objectContaining({
      name: 'override', budget: { tokens: 500, minutes: 20 }, capabilities: expect.any(Object),
    }));

    const createPath = `${BASE}/${manager.id}/tasks`;
    const task = { projectId, workflow: 'override', task: 'Report status mock:done', runner: 'claude' };
    expect((await request(createPath, { ...task, budget: { tokens: 1.5 } })).status).toBe(400);
    expect((await request(createPath, { ...task, secrets: ['CHECK_TOKEN'] })).status).toBe(400);
    expect((await request(`${prefix}/runs`, { ...task, budget: { minutes: -1 } })).status).toBe(400);
    expect((await apiRequest(app, `${BASE}/${manager.id}/agents?projectId=${outsideProject.id}`)).status).toBe(403);
    await cli(['agents', '--project', outsideProject.id], 1);
    for (const path of [createPath, `${prefix}/runs`]) {
      expect((await request(path, { ...task, secrets: ['SHADOWED_TOKEN'] })).status).toBe(400);
    }
    await cli(['task', 'create', '--budget-tokens', '0', 'Invalid'], 1);
    expect(store.listRuns()).toHaveLength(0);

    const output = await cli(['task', 'create', '--project', projectId, '--workflow', 'override', '--runner', 'claude',
      '--secrets', 'CLI_TOKEN', '--budget-tokens', '800', '--budget-usd', '0.5', task.task]);
    const runId = /\[\[task:[^/]+\/([^\]]+)\]\]/.exec(output)?.[1];
    expect(runId).toBeTruthy();
    const record = () => store.getRun(runId!);
    await expect.poll(() => record()?.status, { timeout: 20_000 }).toMatch(/done|review/);
    const persisted = await apiRequest(app, `${prefix}/runs/${runId}`);
    expect(await persisted.json()).toMatchObject({ secretNames: ['CLI_TOKEN'], budget: { tokens: 800, minutes: 20, usd: 0.5 } });
    const launch = specs.at(-1);
    expect(launch?.env?.CLI_TOKEN).toBe('synthetic-value-123');
    expect(launch?.env?.WORKFLOW_TOKEN).toBeUndefined();
    expect(launch?.env?.CHECK_TOKEN).toBeUndefined();

    expect((await request(`${BASE}/${manager.id}/task-message`, { projectId, runId, text: 'Continue mock:done' })).status).toBe(200);
    await expect.poll(() => specs.at(-1), { timeout: 20_000 }).not.toBe(launch);
    expect(specs.at(-1)?.env?.CLI_TOKEN).toBe('synthetic-value-123');
    expect(specs.at(-1)?.env?.WORKFLOW_TOKEN).toBeUndefined();

    for (const flags of [[], ['--secrets', '']]) {
      const text = await cli(['task', 'create', '--project', projectId, '--workflow', 'override', '--runner', 'claude', ...flags, task.task]);
      const id = /\[\[task:[^/]+\/([^\]]+)\]\]/.exec(text)?.[1];
      expect(id).toBeTruthy();
      await expect.poll(() => store.getRun(id!)?.status, { timeout: 20_000 }).toMatch(/done|review/);
      const expected = flags.length ? undefined : 'synthetic-value-123';
      const original = specs.at(-1);
      expect(original?.env?.WORKFLOW_TOKEN).toBe(expected);
      expect((await request(`${BASE}/${manager.id}/task-message`, { projectId, runId: id, text: 'Continue mock:done' })).status).toBe(200);
      await expect.poll(() => specs.at(-1), { timeout: 20_000 }).not.toBe(original);
      expect(specs.at(-1)?.env?.WORKFLOW_TOKEN).toBe(expected);
    }

    // Corrupt the synthetic ciphertext while preserving discoverable metadata.
    const vaultPath = join(process.env.CEZ_HOME!, 'secrets', 'workspace.json');
    const vault = JSON.parse(readFileSync(vaultPath, 'utf8'));
    vault.secrets.WORKFLOW_TOKEN.tag = Buffer.alloc(16).toString('base64');
    writeFileSync(vaultPath, JSON.stringify(vault));
    expect(await cli(['secrets', ...flags])).toContain('Workflow token');
    for (const path of [createPath, `${prefix}/runs`]) {
      expect((await request(path, { ...task, secrets: ['WORKFLOW_TOKEN'] })).status).toBe(400);
    }
  }, 60_000);

  it('refuses managed grants on an unselected workflow runner and rechecks the account on Continue', async () => {
    const created = await request(BASE, {
      instructions: 'Help with tasks', projects: [bootProjectId], cronMinutes: 0,
      taskAgents: [{ runner: 'claude', agentProfile: 'default' }],
    });
    expect(created.status).toBe(201);
    const { id } = await created.json() as { id: string };
    await engine.update(id, { followUp: false, notify: false });
    const prefix = `/api/v1/p/${bootProjectId}`;
    expect((await apiRequest(app, `${prefix}/secrets/TASK_TOKEN`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'synthetic-task-token', audiences: ['agents'] }),
    })).status).toBe(204);
    const create = async (workflow: string) => {
      const response = await request(`${BASE}/${id}/tasks`, {
        projectId: bootProjectId, task: 'Check policy mock:done', workflow, secrets: ['TASK_TOKEN'],
      });
      expect(response.status).toBe(201);
      return (await response.json() as { runId: string }).runId;
    };
    const blocked = await create('instructions'); // The first step pins Codex.
    await expect.poll(() => store.getRun(blocked)?.status, { timeout: 20_000 }).toBe('failed');
    expect(store.getRun(blocked)?.error).toMatch(/manager's account selection.*codex account default/);
    expect(specs).toHaveLength(0);

    const allowed = await create('quick-task');
    await expect.poll(() => store.getRun(allowed)?.status, { timeout: 20_000 }).toMatch(/done|review/);
    expect(specs.at(-1)?.env?.TASK_TOKEN).toBe('synthetic-task-token');
    await mergeWriteAgentAccounts((settings) => ({
      ...settings, accounts: [{ id: 'other', provider: 'claude', label: 'Other', configDir: root, addedAt: '' }],
    }));
    await engine.update(id, { taskAgents: [{ runner: 'claude', agentProfile: 'other' }] });
    const launches = specs.length;
    expect((await request(`${prefix}/runs/${allowed}/continue`, { text: 'Continue mock:done' })).status).toBe(200);
    await expect.poll(() => store.getRun(allowed)?.status, { timeout: 20_000 }).toBe('failed');
    expect(store.getRun(allowed)?.error).toMatch(/manager's account selection.*claude account default/);
    expect(specs).toHaveLength(launches);
  }, 60_000);

  it.each([undefined, 'https://github.com/open-mercato/demo/pull/42'])(
    'answers the built-in review gate via task say before publishing (existing PR: %s)', async (existing) => {
    const publish = vi.spyOn(pullRequests, 'createDraftPr');
    const { managerId, projectId, runId } = await createTask('implement-review-pr', 'claude', 'Fix the module mock:verdict=approve');
    const record = () => store.getRun(runId);
    await expect.poll(() => record()?.steps.find((step) => step.id === 'gate')?.status, { timeout: 20_000 }).toBe('waiting');
    expect(record()?.pullRequestUrl).toBeUndefined();
    if (existing) store.updateRun(runId, { pullRequestUrl: existing });

    const text = 'Recheck the changelog and open a full PR. mock:verdict=applied';
    const response = await request(`${BASE}/${managerId}/task-message`, { projectId, runId, text });
    expect(response.status).toBe(200);
    await expect.poll(() => record()?.status, { timeout: 20_000 }).toMatch(/^(done|review|failed)$/);
    expect(record()).toMatchObject({
      status: expect.stringMatching(/^(done|review)$/),
      pullRequestUrl: existing ?? 'https://github.com/open-mercato/demo/pull/777',
    });
    expect(record()?.error).toBeUndefined();
    expect(record()?.steps.map((step) => [step.id, step.status])).toContainEqual(['pr', 'done']);
    expect(specs.at(-1)?.userPrompt).toContain(text);
    expect(specs.at(-1)?.userPrompt).toContain('ready for review');
    expect(specs.at(-1)?.resume).toBe(true);
    expect(publish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      draft: false, ...(existing ? { updateExisting: true } : {}),
    }));
    expect(publish.mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(ClaudeCliRunner.prototype.startSession).mock.invocationCallOrder.at(-1)!,
    );
  }, 40_000);

  function assertInstructions(spec: AgentRunSpec, global = GLOBAL, project = PROJECT) {
    expect(spec.systemPrompt?.split(GLOBAL)).toHaveLength(2);
    expect(spec.systemPrompt?.split(PROJECT)).toHaveLength(2);
    expect(spec.systemPrompt?.split(global)).toHaveLength(2);
    expect(spec.systemPrompt?.split(project)).toHaveLength(2);
    expect(spec.systemPrompt?.split(GUARD)).toHaveLength(2);
    expect(spec.systemPrompt).toContain('take precedence over repository, project, workflow and skill instructions');
  }

  it('preserves global, project and skill instructions across workflow backend changes and manager Continue', async () => {
    const task = await createTask('instructions', 'codex');
    await expect.poll(() => store.getRun(task.runId)?.status, { timeout: 20_000 }).toMatch(/done|review/);
    const first = specs.filter((spec) => spec.cwd === store.getRun(task.runId)?.worktreePath);
    expect(first).toHaveLength(2);
    for (const spec of first) assertInstructions(spec);
    expect(first[0]?.systemPrompt).toContain(SKILL);
    const previousCount = specs.length;
    const response = await request(`${BASE}/${task.managerId}/task-message`, { projectId: task.projectId, runId: task.runId, text: 'Continue mock:done' });
    expect(response.status).toBe(200);
    await expect.poll(() => specs.length, { timeout: 20_000 }).toBeGreaterThan(previousCount);
    const continued = specs.at(-1);
    if (!continued) throw new Error('missing continued session');
    assertInstructions(continued);
    await expect.poll(() => store.getRun(task.runId)?.status, { timeout: 20_000 }).toMatch(/waiting|done|review/);
  }, 45_000);

  it('preserves instructions when a workflow node spawns a sub-workflow', async () => {
    writeFileSync(join(root, '.ai/cezar/workflows/spawn.yaml'), JSON.stringify({
      version: 2, name: 'spawn',
      nodes: [
        { id: 'start', type: 'start' },
        { id: 'child', type: 'workflow', workflow: 'instructions', runner: 'codex', prompt: '{{task}}' },
        { id: 'end', type: 'end', status: 'success' },
      ],
      edges: [{ from: 'start', to: 'child' }, { from: 'child.done', to: 'end' }],
    }));
    const parent = await createTask('spawn', 'claude');
    await expect.poll(() => store.getRun(parent.runId)?.status, { timeout: 20_000 }).toMatch(/done|review|failed/);
    expect(store.getRun(parent.runId)?.status, JSON.stringify(store.getRun(parent.runId))).toMatch(/done|review/);
    const children = store.listRuns().filter((run) => run.dispatch?.parentRunId === parent.runId);
    expect(children).toHaveLength(1);
    const child = children[0];
    const childSpecs = specs.filter((spec) => spec.cwd === child?.worktreePath);
    expect(childSpecs).toHaveLength(2);
    for (const spec of childSpecs) assertInstructions(spec);
    expect(childSpecs[0]?.systemPrompt).toContain(SKILL);
  }, 45_000);

  it.each(['claude', 'codex'] as const)('propagates current instructions and manager restrictions to a dispatched %s child exactly once', async (runner) => {
    const parent = await createTask('quick-task', 'claude');
    await expect.poll(() => store.getRun(parent.runId)?.status, { timeout: 20_000 }).toMatch(/done|review/);
    // Dispatch requires a live parent. Reopen it with a turn that waits for user input.
    expect(runs.continueRun(parent.runId, { text: 'Keep investigating' }).ok).toBe(true);
    await expect.poll(() => store.getRun(parent.runId)?.status, { timeout: 20_000 }).toBe('waiting');
    const global = `${GLOBAL} Use the updated global guidance.`;
    const project = `${PROJECT} Use the updated project guidance.`;
    await mergeWriteWorkspaceConfig((config) => { config.systemPrompt = global; });
    writeFileSync(join(root, '.ai/cezar/config.json'), JSON.stringify({ systemPrompt: project }));
    if (runner === 'claude') delete process.env.CEZ_API_URL;
    const child = runs.dispatch(parent.runId, { objective: 'Investigate independently mock:done', runner, kind: 'review' }, {
      workflow: { name: '(planned)', source: 'built-in', steps: [{ id: 'task', prompt: '{{task}}' }, { id: 'verify', command: 'true' }] },
    });
    if ('refused' in child) throw new Error(child.refused);
    await expect.poll(() => specs.some((spec) => spec.cwd === store.getRun(child.id)?.worktreePath), { timeout: 20_000 }).toBe(true);
    const spec = specs.find((candidate) => candidate.cwd === store.getRun(child.id)?.worktreePath);
    if (!spec) throw new Error('missing child session');
    assertInstructions(spec, global, project);
    expect(spec.systemPrompt?.split(composeDispatchPrompt('review'))).toHaveLength(2);
    await expect.poll(() => store.getRun(child.id)?.status, { timeout: 20_000 }).toMatch(/done|review/);
  }, 45_000);
});
