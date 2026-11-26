import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexAppServerRunner } from '../core/codex-app-server-runner.ts';
import { mergeWriteWorkspaceConfig } from '../workspace/config.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { OpencodeServerRunner } from '../core/opencode-server-runner.ts';
import { ProviderAuthService } from '../core/provider-auth.ts';
import * as taskPr from '../server/forge/task-pr.ts';
import { apiRequest } from '../server/loopback-request.testkit.ts';
import { createApp } from '../server/server.ts';
import * as templates from './templates.ts';
import { RunStore } from '../runs/store.ts';
import { graphToSteps, type WorkflowGraph } from './graph.ts';
import { loadWorkflows, resolveWorkflowModelAlias } from './load.ts';
import { MISSING_SESSION_NOTE } from './resume-fallback.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';
import { track } from '../telemetry.ts';

vi.mock('../telemetry.ts', async (importOriginal) => ({ ...(await importOriginal<object>()), track: vi.fn() }));

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * Graph workflows end to end (spec 2026-09-30-workflow-node-editor, phase 1): a real
 * RunManager, the bundled mock agent (`CEZ_DRY_RUN=1`), real check commands.
 */
describe('graph workflows run through RunManager', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let savedDryRun: string | undefined;

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-graph-run-'));
    savedDryRun = process.env.CEZ_DRY_RUN;
    process.env.CEZ_DRY_RUN = '1';
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterEach(() => {
    manager.dispose();
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  async function settle(id: string) {
    const terminal = new Set(['done', 'review', 'failed', 'cancelled']);
    const deadline = Date.now() + 20_000;
    while (!terminal.has(store.getRun(id)?.status ?? '')) {
      if (Date.now() > deadline) throw new Error('run did not finish in time');
      await new Promise((r) => setTimeout(r, 100));
    }
    return store.getRun(id)!;
  }

  function def(graph: WorkflowGraph): WorkflowDef {
    return { name: 'graph', source: 'file', steps: graphToSteps(graph), graph };
  }

  async function builtin(name: string): Promise<WorkflowDef> {
    const settings = join(repoRoot, '.ai/cezar/config.json');
    try {
      writeFileSync(settings, JSON.stringify({ defaultRunner: 'codex' }), { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const { workflows } = await loadWorkflows(repoRoot);
    const workflow = workflows.find((entry) => entry.name === name);
    expect(workflow).toBeDefined();
    return workflow!;
  }

  it.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')('lowers the CPU priority of workflow checks', async () => {
    const command = `'${process.execPath}' -p 'require("node:os").getPriority()'`;
    const workflow: WorkflowDef = { name: 'priority', source: 'file', steps: [{ id: 'check', command }] };
    const run = manager.startRun(workflow, { task: 'Check inherited priority' });
    expect((await settle(run.id)).status).toMatch(/review|done/);
    const output = store.readEvents(run.id).find((event) => event.type === 'check-output');
    expect(Number(output?.text)).toBeGreaterThanOrEqual(5);
  });

  it.each([false, true])('skips side-effect checks and follows the success edge during replay (graph: %s)', async (graph) => {
    const riskyCheck = { id: 'external', command: 'exit 7', sideEffects: true };
    const localCheck = { id: 'local', command: 'printf verified' };
    const workflow: WorkflowDef = graph ? def({
      nodes: [{ id: 'start', type: 'start' }, { ...riskyCheck, type: 'check' }, { ...localCheck, type: 'check' }],
      edges: [{ from: 'start.next', to: 'external' }, { from: 'external.pass', to: 'local' }],
    }) : { name: 'chain', source: 'file', steps: [riskyCheck, localCheck] };
    const replay = manager.startRun(workflow, { task: 'Repeat the local check.' });
    store.updateRun(replay.id, { replayOf: 'baseline' });
    expect((await settle(replay.id)).status).toMatch(/done|review/);
    expect(store.readEvents(replay.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'note', stepId: 'external', message: 'Side-effect check skipped during replay.' }),
      expect.objectContaining({ type: 'check-output', stepId: 'local', text: 'verified' }),
    ]));
    expect(store.readEvents(replay.id).some((event) => event.type === 'check-output' && event.stepId === 'external')).toBe(false);
    const ordinary = manager.startRun(workflow, { task: 'Run the complete workflow.' });
    expect((await settle(ordinary.id)).status).toBe('failed');
  });

  it('provides factory workflow defaults and lets project files override all three', async () => {
    const defaults = [
      ['implement', undefined, 3_000_000, 30],
      ['plan', undefined, 1_500_000, 20],
      ['operate', 'low-reasoning', 800_000, 20],
    ] as const;
    const dir = join(repoRoot, '.ai/cezar/workflows');
    mkdirSync(dir, { recursive: true });
    for (const [name, model, tokens, minutes] of defaults) {
      const workflow = await builtin(name);
      expect(workflow.budget).toEqual({ tokens, minutes });
      expect(workflow.steps[0]?.model).toBe(model);
      expect(workflow.steps[0]?.runner).toBeUndefined();
      writeFileSync(join(dir, `${name}.yaml`), `name: ${name}\nsteps:\n  - id: local\n    prompt: Project override\n`);
      expect(await builtin(name)).toMatchObject({ source: 'file', steps: [{ id: 'local' }] });
    }
  });

  it.each([undefined, {}, { validation: {} }])('falls back to the package test script with config %j', async (config) => {
    if (config !== undefined) writeFileSync(join(repoRoot, '.ai/agentic.config.json'), JSON.stringify(config));
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
    expect((await builtin('implement')).steps.filter((step) => step.command).map((step) => step.command)).toEqual(['npm test']);
  });

  it.each([
    { config: null, issue: 'unable to read validation configuration' },
    { config: '{', issue: 'validation configuration is not valid JSON' },
    { config: '{"validation":null}', issue: 'validation.commands must be an array' },
    { config: '{"validation":{"commands":["true",42]}}', issue: 'validation.commands must be an array' },
    { config: '{"validation":{"commands":["true","  "]}}', issue: 'validation.commands must be an array' },
  ])('keeps other workflows available when implement cannot use its validation config ($config)', async ({ config, issue }) => {
    const path = join(repoRoot, '.ai/agentic.config.json');
    if (config === null) mkdirSync(path);
    else writeFileSync(path, config);
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
    const { workflows, issues } = await loadWorkflows(repoRoot);
    expect(workflows.map(({ name }) => name)).toContain('quick-task');
    expect(workflows.map(({ name }) => name)).not.toContain('implement');
    expect(issues).toEqual([{ path, message: expect.stringContaining(issue) }]);
  });

  it('runs discovered commands with literal brace expressions', async () => {
    writeFileSync(join(repoRoot, '.ai/agentic.config.json'), JSON.stringify({ validation: { commands: [
      "printf '%s' '{{nodes.unknown.output}} {{task}}'",
      "printf '%s' '{{nodes.check-1.output}}'",
    ] } }));
    const final = await settle(manager.startRun(await builtin('implement'), { task: 'inspect literal commands' }).id);
    expect(final.status).not.toBe('failed');
    expect(final.graphState?.outputs).toMatchObject({
      'check-1': { output: '{{nodes.unknown.output}} {{task}}', exitCode: 0 },
      'check-2': { output: '{{nodes.check-1.output}}', exitCode: 0 },
    });
  }, 30_000);

  it('reports an implement construction error and still loads quick-task', async () => {
    const build = vi.spyOn(templates, 'implementWorkflow').mockImplementationOnce(() => {
      throw new Error('test construction failure');
    });
    try {
      const { workflows, issues } = await loadWorkflows(repoRoot);
      expect(workflows.map((workflow) => workflow.name)).toContain('quick-task');
      expect(workflows.map((workflow) => workflow.name)).not.toContain('implement');
      expect(issues).toEqual([expect.objectContaining({ message: expect.stringContaining('test construction failure') })]);
    } finally {
      build.mockRestore();
    }
  });

  it.each([
    { forge: 'GitHub', source: 'manual', needsRepair: false, remote: null, url: /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/777$/ },
    { forge: 'Azure', source: 'manual', needsRepair: false, remote: 'https://dev.azure.com/test/project/_git/repo', url: /^https:\/\/dev\.azure\.com\/test\/project\/_git\/repo\/pullrequest\/777$/ },
    { forge: 'Azure', source: 'manager', needsRepair: true, remote: 'https://dev.azure.com/test/project/_git/repo', url: /^https:\/\/dev\.azure\.com\/test\/project\/_git\/repo\/pullrequest\/777$/ },
  ])('publishes one $forge PR for a $source task after ordered checks pass', async ({ source, needsRepair, remote, url }) => {
    if (remote) await run('git', ['remote', 'add', 'origin', remote], { cwd: repoRoot });
    const second = 'echo second >> checks.log; echo check-rewrite > a.txt';
    writeFileSync(join(repoRoot, '.ai/agentic.config.json'), JSON.stringify({ validation: { commands: [
      'echo first >> checks.log',
      needsRepair ? `${second}; test -f .attempted || { touch .attempted; exit 1; }` : second,
    ] } }));
    const original = CodexAppServerRunner.prototype.startSession;
    const launch = vi.spyOn(CodexAppServerRunner.prototype, 'startSession').mockImplementationOnce(function (this: CodexAppServerRunner, ...args) {
      writeFileSync(join(args[0].cwd, 'agent-change.txt'), 'agent change\n');
      return original.apply(this, args);
    });
    const publish = vi.spyOn(taskPr, 'createTaskPr');
    try {
      const workflow = await builtin('implement');
      expect(workflow.graph?.nodes.some((node) => node.type === 'gate.human')).toBe(false);
      const app = createApp({ repoRoot, store, manager, version: 'test' });
      const response = await apiRequest(app, '/api/v1/runs', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workflow: 'implement',
          task: 'Implement the change and open a regular PR.',
          ...(source === 'manager' ? { startedByManager: { id: 'fixture', name: 'Fixture manager' } } : {}),
        }),
      });
      expect(response.status).toBe(201);
      const { id } = await response.json() as { id: string };
      const early = await apiRequest(app, `/api/v1/runs/${id}/pr`, { method: 'POST' });
      expect(early.status).toBe(409);
      expect(await early.json()).toEqual({ error: 'run is still active — finish the agent step so the workflow can publish the PR' });
      const final = await settle(id);
      expect(final.status, final.error).not.toBe('failed');
      const cwd = final.worktreePath!;
      expect(readFileSync(join(cwd, 'checks.log'), 'utf8')).toBe('first\nsecond\n'.repeat(needsRepair ? 2 : 1));
      expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('check-rewrite\n');
      expect(final.graphState?.loops?.retry ?? 0).toBe(needsRepair ? 1 : 0);
      expect(final.graphState?.taken).toContain('check-2.pass->pr');
      expect(publish).toHaveBeenCalledTimes(1);
      expect(launch.mock.calls[0]?.[0]?.systemPrompt).toContain('Do not push, open a PR, or mark a PR ready yourself');
      expect(publish.mock.calls[0]?.[0].draft ?? true).toBe(true);
      expect(final.pullRequestUrl).toMatch(url);
      expect(store.readEvents(id).some((event) => event.type === 'ask.requested')).toBe(false);
      const { stdout } = await run('git', ['diff', '--name-only', `${final.baseBranch}...HEAD`], { cwd });
      expect(stdout.trim()).toBe('agent-change.txt');
    } finally {
      publish.mockRestore();
      launch.mockRestore();
    }
  }, 30_000);

  it.each([true, false])('sets publication guidance based on a custom graph PR step: %s', async (publishes) => {
    const original = CodexAppServerRunner.prototype.startSession;
    const launch = vi.spyOn(CodexAppServerRunner.prototype, 'startSession').mockImplementationOnce(function (this: CodexAppServerRunner, ...args) {
      writeFileSync(join(args[0].cwd, 'custom-change.txt'), 'Custom change\n');
      return original.apply(this, args);
    });
    try {
      const workflow = def({
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'edit', type: 'agent', runner: 'codex', prompt: 'Change the file and open a regular PR.' },
          { id: 'check', type: 'check', command: 'true' },
          ...(publishes ? [{ id: 'publish', type: 'github.draft-pr' } as const] : []),
          { id: 'end', type: 'end', status: 'success' },
        ],
        edges: [
          { from: 'start', to: 'edit' },
          { from: 'edit.done', to: 'check' },
          { from: 'check.pass', to: publishes ? 'publish' : 'end' },
          ...(publishes ? [{ from: 'publish.created', to: 'end' }] : []),
        ],
      });
      const final = await settle(manager.startRun(workflow, { task: 'Edit the file' }).id);
      expect(final.status).not.toBe('failed');
      expect(Boolean(final.pullRequestUrl)).toBe(publishes);
      const guidance = 'Do not push, open a PR, or mark a PR ready yourself';
      expect(launch.mock.calls[0]?.[0]?.systemPrompt?.includes(guidance)).toBe(publishes);
    } finally {
      launch.mockRestore();
    }
  }, 30_000);

  it('does not publish a branch whose only changes are check artifacts', async () => {
    const final = await settle(manager.startRun(templates.implementWorkflow(['echo report > checks.log']), { task: 'inspect', runner: 'codex' }).id);
    expect(final.status, final.error).not.toBe('failed');
    expect(final.graphState?.taken).toContain('pr.nothing->done');
    expect(final.pullRequestUrl).toBeUndefined();
    expect(readFileSync(join(final.worktreePath!, 'checks.log'), 'utf8')).toBe('report\n');
  }, 30_000);

  it('keeps skipped checks from the previous pass out of the next repair prompt', async () => {
    const launch = vi.spyOn(CodexAppServerRunner.prototype, 'startSession');
    try {
      const workflow = templates.implementWorkflow([
        'test "$CEZ_ATTEMPT" = 1 || { echo current-first-failure; exit 1; }',
        'echo earlier-second-failure; exit 1',
      ]);
      const final = await settle(manager.startRun(workflow, { task: 'repair validation', runner: 'codex' }).id);
      expect(final.status).toBe('failed');
      const prompts = launch.mock.calls.map(([spec]) => spec.userPrompt);
      expect(prompts).toHaveLength(3);
      expect(prompts[1]).toContain('earlier-second-failure');
      expect(prompts[2]).toContain('current-first-failure');
      expect(prompts[2]).not.toContain('earlier-second-failure');
      expect(final.graphState?.outputs).not.toHaveProperty('check-2');
    } finally {
      launch.mockRestore();
    }
  }, 30_000);

  it('stops implement before validation can mutate an unsafe checkpoint', async () => {
    const original = CodexAppServerRunner.prototype.startSession;
    const conflict = '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> other\n';
    const launch = vi.spyOn(CodexAppServerRunner.prototype, 'startSession').mockImplementationOnce(function (this: CodexAppServerRunner, ...args) {
      writeFileSync(join(args[0].cwd, 'a.txt'), conflict);
      return original.apply(this, args);
    });
    try {
      const workflow = templates.implementWorkflow(['echo resolved > a.txt; echo residue > checks.log']);
      const final = await settle(manager.startRun(workflow, { task: 'implement change', runner: 'codex' }).id);
      expect(final.status).toBe('failed');
      expect(final.error).toContain('unable to checkpoint changes before validation');
      expect(final.steps.find((step) => step.id === 'pr')?.status).toBe('pending');
      expect(final.pullRequestUrl).toBeUndefined();
      expect(readFileSync(join(final.worktreePath!, 'a.txt'), 'utf8')).toBe(conflict);
      expect(store.readEvents(final.id).some((event) => event.type === 'check-output')).toBe(false);
    } finally {
      launch.mockRestore();
    }
  }, 30_000);

  it('stops implement after two repairs without creating a PR', async () => {
    writeFileSync(join(repoRoot, '.ai/agentic.config.json'), JSON.stringify({ validation: { commands: ['exit 1', 'exit 0'] } }));
    const final = await settle(manager.startRun(await builtin('implement'), { task: 'never passes', worktree: false }).id);
    expect(final.status).toBe('failed');
    expect(final.steps.find((s) => s.id === 'check-1')?.iterations).toBe(3);
    expect(final.steps.find((s) => s.id === 'check-2')?.status).toBe('pending');
    expect(final.steps.find((s) => s.id === 'fix')?.iterations).toBe(2);
    expect(final.graphState?.taken).toContain('retry.exhausted->stopped');
    expect(final.steps.find((s) => s.id === 'pr')?.status).toBe('pending');
    expect(final.pullRequestUrl).toBeUndefined();
  }, 30_000);

  it('launches plan with backend read-only enforcement', async () => {
    const id = manager.startRun(await builtin('plan'), { task: 'inspect the repo' }).id;
    await vi.waitFor(() => expect(store.getRun(id)?.status).toBe('waiting'), { timeout: 15_000 });
    expect(manager.finish(id)).toBe(true);
    const final = await settle(id);
    expect(final.status).not.toBe('failed');
    expect(final.readOnly).toBe(true);
    expect(final.steps[0]?.toolPolicy).toMatchObject({ enforceReadOnly: true, allowedTools: ['Read', 'Grep', 'Glob'] });
    expect(final.pullRequestUrl).toBeUndefined();
  }, 30_000);

  it('keeps both Plan variants read-only through HTTP without creating branches or worktrees', async () => {
    const app = createApp({ repoRoot, store, manager, version: 'test' });
    const response = await apiRequest(app, '/api/v1/runs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workflow: 'plan', task: 'inspect the repo', runner: 'codex', variants: 2 }),
    });
    expect(response.status).toBe(201);
    const { runs } = await response.json() as { runs: { id: string }[] };
    expect(runs).toHaveLength(2);
    for (const { id } of runs) {
      await vi.waitFor(() => expect(store.getRun(id)?.status).toBe('waiting'), { timeout: 15_000 });
      expect(manager.finish(id)).toBe(true);
      const final = await settle(id);
      expect(final).toMatchObject({ readOnly: true, enforceReadOnly: true, worktree: false });
      expect(final.branch).toBeUndefined();
      expect(final.worktreePath).toBeUndefined();
      expect(final.steps[0]?.toolPolicy).toMatchObject({ enforceReadOnly: true, allowedTools: ['Read', 'Grep', 'Glob'] });
    }
    const { stdout } = await run('git', ['branch', '--format=%(refname:short)'], { cwd: repoRoot });
    expect(stdout.trim()).toBe('main');
  }, 45_000);

  it('opens a draft PR and notes when no validation is configured', async () => {
    const original = CodexAppServerRunner.prototype.startSession;
    const launch = vi.spyOn(CodexAppServerRunner.prototype, 'startSession').mockImplementationOnce(function (this: CodexAppServerRunner, ...args) {
      writeFileSync(join(args[0].cwd, 'agent-change.txt'), 'agent change\n');
      return original.apply(this, args);
    });
    try {
      const final = await settle(manager.startRun(await builtin('implement'), { task: 'implement change' }).id);
      expect(final.pullRequestUrl).toMatch(/\/777$/);
      expect(final.graphState?.taken).toContain('work.done->pr');
      const events = store.readEvents(final.id);
      expect(events).toContainEqual(expect.objectContaining({ type: 'note', message: 'No validation is configured for Implement.' }));
      expect(events.some((event) => event.type === 'check-output')).toBe(false);
    } finally {
      launch.mockRestore();
    }
  }, 30_000);

  it('names a composer slash skill in the capability block of a selected workflow', async () => {
    mkdirSync(join(repoRoot, '.ai/cezar/skills'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai/cezar/skills/fixture-review.md'), [
      '---', 'name: fixture-review', 'description: Summarize a fixture.', '---', 'Read the fixture.',
    ].join('\n'));
    const launch = vi.spyOn(CodexAppServerRunner.prototype, 'startSession');
    try {
      const app = createApp({ repoRoot, store, manager, version: 'test' });
      const response = await apiRequest(app, '/api/v1/runs', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workflow: 'plan', task: '/fixture-review read the fixture', runner: 'codex' }),
      });
      expect(response.status).toBe(201);
      const { id } = await response.json() as { id: string };
      await vi.waitFor(() => expect(launch).toHaveBeenCalled(), { timeout: 15_000 });
      expect(launch.mock.calls[0]?.[0]?.userPrompt).toContain('Selected skill: /fixture-review');
      expect(launch.mock.calls[0]?.[0]?.systemPrompt).toContain('Attached skill: fixture-review');
      expect(store.getRun(id)?.workflow).toBe('plan');
    } finally {
      launch.mockRestore();
    }
  }, 30_000);

  it.each([false, true])('launches Operate through HTTP with a workspace alias configured: %s', async (configured) => {
    const model = 'mock/mock-model';
    const prior = await mergeWriteWorkspaceConfig((config) => config);
    await mergeWriteWorkspaceConfig((config) => {
      config.factory = configured ? { models: { lowReasoning: { runner: 'opencode', model } } } : undefined;
    });
    writeFileSync(join(repoRoot, '.ai/cezar/config.json'), JSON.stringify({ defaultRunner: 'codex', defaultModelsAuto: { codex: true } }));
    const openCodeLaunch = vi.spyOn(OpencodeServerRunner.prototype, 'startSession');
    const codexLaunch = vi.spyOn(CodexAppServerRunner.prototype, 'startSession');
    try {
      const providerAuth = new ProviderAuthService({ cwd: repoRoot });
      const preflight = vi.spyOn(providerAuth, 'status');
      const app = createApp({ repoRoot, store, manager, version: 'test', providerAuth });
      const response = await apiRequest(app, '/api/v1/runs', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workflow: 'operate', task: 'report status', runner: 'codex', model: 'fixture-task-model', worktree: false }),
      });
      expect(response.status).toBe(201);
      expect(preflight).toHaveBeenCalled();
      const { id } = await response.json() as { id: string };
      await vi.waitFor(() => expect(store.getRun(id)?.status).toBe('waiting'), { timeout: 15_000 });
      if (configured) {
        expect(openCodeLaunch.mock.calls[0]?.[0]?.model).toBe(model);
        expect(codexLaunch).not.toHaveBeenCalled();
      } else {
        expect(codexLaunch.mock.calls[0]?.[0]).toMatchObject({ reasoningEffort: 'low' });
        expect(codexLaunch.mock.calls[0]?.[0]?.model).toBeUndefined();
        expect(openCodeLaunch).not.toHaveBeenCalled();
      }
      expect(store.readEvents(id).some((event) =>
        event.type === 'note' && String(event.message).includes('Using the project default runner'))).toBe(!configured);
      expect(manager.finish(id)).toBe(true);
      await settle(id);
    } finally {
      openCodeLaunch.mockRestore();
      codexLaunch.mockRestore();
      await mergeWriteWorkspaceConfig((config) => { config.factory = prior.factory; });
    }
  }, 30_000);

  it.each([
    { label: 'reachable', primary: true, codexHeld: false, claudeHeld: false, runner: 'opencode', model: 'mock/primary' },
    { label: 'unreachable', primary: false, codexHeld: false, claudeHeld: false, runner: 'codex', model: 'fixture-first' },
    { label: 'first held', primary: false, codexHeld: true, claudeHeld: false, runner: 'claude', model: 'fixture-second' },
    { label: 'all held', primary: false, codexHeld: true, claudeHeld: true, runner: 'claude', model: 'fixture-second' },
  ] as const)('chooses a low-tier route with the $label primary or fallbacks', async (test) => {
    const healthUrl = `http://127.0.0.1:9999/models/${encodeURIComponent(test.label)}`;
    const prior = await mergeWriteWorkspaceConfig((config) => config);
    await mergeWriteWorkspaceConfig((config) => {
      config.factory = { models: {
        lowReasoning: { runner: 'opencode', model: 'mock/primary', healthUrl },
        lowReasoningFallback: [
          { runner: 'codex', model: 'fixture-first' },
          { runner: 'claude', model: 'fixture-second' },
        ],
      } };
    });
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: test.primary ? 401 : 503 }));
    try {
      const workflow = await builtin('operate');
      const now = Date.now();
      const select = () => resolveWorkflowModelAlias(workflow, repoRoot, undefined, {
        accountFor: async (runner) => ({
          runner, account: 'default', label: 'fixture account',
          ...(runner === 'codex' && test.codexHeld ? { until: now + 180_000 } : {}),
          ...(runner === 'claude' && test.claudeHeld ? { until: now + 60_000 } : {}),
        }),
      });
      for (const selection of [await select(), await select()]) {
        expect(selection.route).toMatchObject({ runner: test.runner, model: test.model });
        expect(selection.workflow.steps[0]).toMatchObject({ runner: test.runner, model: test.model });
        expect(selection.notes?.some((note) => note.includes('hosted fallback'))).toBe(!test.primary);
      }
      const deadlines = new Map<string, number>();
      if (test.codexHeld) deadlines.set('codex:default', now + 180_000);
      if (test.claudeHeld) deadlines.set('claude:default', now + 60_000);
      const semaphore = new WorkspaceSemaphore();
      vi.spyOn(semaphore, 'accountHolds').mockReturnValue({
        deadlines, deadline: new Set(deadlines.keys()), inFlight: new Set(),
      });
      manager.dispose();
      manager = new RunManager(store, repoRoot, { semaphore });
      const app = createApp({ repoRoot, store, manager, version: 'test', semaphore });
      const response = await apiRequest(app, '/api/v1/runs', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workflow: 'operate', task: 'Report fixture status', worktree: false }),
      });
      expect(response.status).toBe(201);
      const { id } = await response.json() as { id: string };
      expect(store.getRun(id)).toMatchObject({ runner: test.runner, model: test.model });
      expect(store.readEvents(id).some((event) => String(event.message).includes('hosted fallback'))).toBe(!test.primary);
      if (test.codexHeld && test.claudeHeld) {
        expect(store.getRun(id)?.status).toBe('queued');
      } else {
        await vi.waitFor(() => expect(store.getRun(id)?.status).toBe('waiting'), { timeout: 15_000 });
        expect(manager.finish(id)).toBe(true);
        await settle(id);
      }
      expect(fetch).toHaveBeenCalledExactlyOnceWith(healthUrl, expect.objectContaining({ redirect: 'error' }));
    } finally {
      fetch.mockRestore();
      await mergeWriteWorkspaceConfig((config) => { config.factory = prior.factory; });
    }
  });

  it('resolves the high-reasoning alias through the project default or the workspace setting', async () => {
    const prior = await mergeWriteWorkspaceConfig((config) => config);
    try {
      const workflow = await builtin('plan');
      const options = { model: 'high-reasoning' };
      await mergeWriteWorkspaceConfig((config) => { config.factory = undefined; });
      const defaults = await resolveWorkflowModelAlias(workflow, repoRoot, undefined, options);
      expect(defaults.route).toMatchObject({ runner: 'codex', reasoningEffort: 'high' });
      expect(defaults.notes?.[0]).toContain('Using the project default runner');
      await mergeWriteWorkspaceConfig((config) => {
        config.factory = { models: { highReasoning: { runner: 'claude', model: 'fixture-high' } } };
      });
      const configured = await resolveWorkflowModelAlias(workflow, repoRoot, undefined, options);
      expect(configured.route).toEqual({ runner: 'claude', model: 'fixture-high' });
    } finally {
      await mergeWriteWorkspaceConfig((config) => { config.factory = prior.factory; });
    }
  });

  // `tests` fails on its first run only. `log` records rendered node refs to a file — the mock
  // agent truncates prompts, so a check command is where the rendering is observable.
  const LOOPING: WorkflowGraph = {
    nodes: [
      { id: 'start', type: 'start' },
      { id: 'implement', type: 'agent', prompt: '{{task}}' },
      { id: 'tests', type: 'check', command: 'test -f .attempted || { touch .attempted; echo BOOM-OUTPUT; exit 1; }' },
      { id: 'retry', type: 'loop', max: 2 },
      { id: 'fix', type: 'agent', prompt: 'fix attempt {{nodes.retry.iteration}} after {{nodes.tests.output}}' },
      { id: 'log', type: 'check', command: 'echo "{{nodes.retry.iteration}}/{{nodes.retry.max}} exit={{nodes.tests.exitCode}}" >> refs.txt' },
      { id: 'ok', type: 'end', status: 'success' },
      { id: 'gave-up', type: 'end', status: 'failed' },
    ],
    edges: [
      { from: 'start', to: 'implement' },
      { from: 'implement', to: 'tests' },
      { from: 'tests.pass', to: 'ok' },
      { from: 'tests.fail', to: 'retry' },
      { from: 'retry.repeat', to: 'fix' },
      { from: 'retry.exhausted', to: 'gave-up' },
      { from: 'fix', to: 'log' },
      { from: 'log', to: 'tests' },
    ],
  };

  it('loops back through the loop node, renders node refs, and ends at the success end', async () => {
    const record = manager.startRun(def(LOOPING), { task: 'build the thing', worktree: false });
    const final = await settle(record.id);

    expect(final.status).not.toBe('failed');
    expect(final.steps.map((s) => [s.id, s.status, s.iterations])).toEqual([
      ['implement', 'done', 1],
      ['tests', 'done', 2],
      ['fix', 'done', 1],
      ['log', 'done', 1],
    ]);
    const notes = readFileSync(join(repoRoot, 'notes.md'), 'utf8').trim().split('\n');
    expect(notes).toHaveLength(2);
    expect(readFileSync(join(repoRoot, 'refs.txt'), 'utf8')).toBe('1/2 exit=1\n');
    // Phase 3: the walk is on the record for the live graph.
    expect(final.graphState).toMatchObject({
      loops: { retry: 1 },
      taken: [
        'start.next->implement',
        'implement.done->tests',
        'tests.fail->retry',
        'retry.repeat->fix',
        'fix.done->log',
        'log.pass->tests',
        'tests.pass->ok',
      ],
    });
  }, 30_000);

  it('fails the run when the loop is exhausted', async () => {
    const graph: WorkflowGraph = {
      ...LOOPING,
      nodes: LOOPING.nodes.map((n) => (n.id === 'tests' ? { id: 'tests', type: 'check', command: 'exit 1' } : n)),
    };
    const final = await settle(manager.startRun(def(graph), { task: 'never passes', worktree: false }).id);
    expect(final.status).toBe('failed');
    expect(final.error).toBe('workflow ended at "gave-up"');
    expect(final.steps.find((s) => s.id === 'tests')?.iterations).toBe(3);
    expect(final.steps.find((s) => s.id === 'fix')?.iterations).toBe(2);
  }, 30_000);

  const REVIEW_FLOW = (reviewPrompt: string): WorkflowGraph => ({
    nodes: [
      { id: 'start', type: 'start' },
      { id: 'implement', type: 'agent', prompt: '{{task}}' },
      { id: 'review', type: 'agent', prompt: reviewPrompt, verdicts: ['approve', 'changes'] },
      { id: 'fix', type: 'agent', prompt: 'address review', session: { continue: 'implement' } },
      { id: 'mark', type: 'check', command: 'echo "{{nodes.review.verdict}}" >> verdicts.txt' },
      { id: 'ok', type: 'end', status: 'success' },
    ],
    edges: [
      { from: 'start', to: 'implement' },
      { from: 'implement', to: 'review' },
      { from: 'review.approve', to: 'mark' },
      { from: 'review.changes', to: 'fix' },
      { from: 'fix', to: 'mark' },
      { from: 'mark', to: 'ok' },
    ],
  });

  it('branches on the verdict the agent ends its turn with', async () => {
    const final = await settle(
      manager.startRun(def(REVIEW_FLOW('review it mock:verdict=approve')), { task: 'x', worktree: false }).id,
    );
    expect(final.status).not.toBe('failed');
    expect(final.steps.map((s) => [s.id, s.status])).toEqual([
      ['implement', 'done'],
      ['review', 'done'],
      ['mark', 'done'],
      ['fix', 'pending'],
    ]);
    expect(readFileSync(join(repoRoot, 'verdicts.txt'), 'utf8')).toBe('approve\n');
  }, 30_000);

  it('nudges once for a missing verdict, and session.continue resumes the named node', async () => {
    const argsFile = join(repoRoot, 'mock-args.ndjson');
    process.env.CEZ_MOCK_ARGS_FILE = argsFile;
    try {
      // No `mock:verdict=` → the first turn has no marker; the nudge is answered with the first
      // listed verdict, `approve`… so to reach `fix` the order is swapped in this graph.
      const graph = REVIEW_FLOW('review it');
      const review = graph.nodes.find((n) => n.id === 'review');
      if (review?.type === 'agent') review.verdicts = ['changes', 'approve'];
      const final = await settle(manager.startRun(def(graph), { task: 'x', worktree: false }).id);
      expect(final.status).not.toBe('failed');
      expect(readFileSync(join(repoRoot, 'verdicts.txt'), 'utf8')).toBe('changes\n');
      const byId = new Map(final.steps.map((s) => [s.id, s]));
      expect(byId.get('fix')?.status).toBe('done');
      // `fix` reopened implement's session rather than minting its own.
      expect(byId.get('fix')?.sessionId).toBe(byId.get('implement')?.sessionId);
      const spawns = readFileSync(argsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]);
      const resumed = spawns.filter((a) => a.includes('--resume')).map((a) => a[a.indexOf('--resume') + 1]);
      // One resume for the nudge (review's own session), one for fix (implement's session).
      expect(resumed).toEqual([byId.get('review')?.sessionId, byId.get('implement')?.sessionId]);
    } finally {
      delete process.env.CEZ_MOCK_ARGS_FILE;
    }
  }, 30_000);

  it('Continue on a pruned Claude session picks up in a fresh session, one clean turn in the thread', async () => {
    const head = async () => (await run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })).stdout.trim();
    const originalCommit = await head();
    const first = await settle(
      manager.startRun({ name: 'one', source: 'file', steps: [{ id: 'work', name: 'Work', prompt: '{{task}}' }, { id: 'verify', command: 'true' }] }, {
        task: 'make buttons use a pointer cursor',
        worktree: false,
        runner: 'claude',
      }).id,
    );
    const oldSession = first.steps.find((s) => s.id === 'work')?.sessionId;
    expect(oldSession).toBeDefined();
    expect(first.steps.find((s) => s.id === 'work')?.taskStats?.requests).toBeGreaterThan(0);
    expect(first).toMatchObject({ startCommit: originalCommit, harnessVersion: { id: expect.any(String) } });
    await run('git', [...GIT_ID, 'commit', '--allow-empty', '-q', '-m', 'new base'], { cwd: repoRoot });
    const continuedCommit = await head();
    process.env.CEZ_MOCK_MISSING_SESSIONS = oldSession!;
    try {
      expect(manager.continueRun(first.id, { text: 'keep going', runner: 'claude' })).toEqual({ ok: true });
      const deadline = Date.now() + 20_000;
      // A Continue parks `waiting` for the user's next message once its turn is answered.
      while (!['waiting', 'done', 'failed'].includes(store.getRun(first.id)?.steps.find((s) => s.id === 'continue-1')?.status ?? '')) {
        if (Date.now() > deadline) throw new Error('continue did not settle in time');
        await new Promise((r) => setTimeout(r, 100));
      }
      const final = store.getRun(first.id)!;
      expect(final.status).toBe('waiting');
      const step = final.steps.find((s) => s.id === 'continue-1');
      expect(final.startCommit).toBe(originalCommit);
      expect(step).toMatchObject({ startCommit: continuedCommit, harnessVersion: first.harnessVersion });
      store.flush();
      const reloaded = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true }).getRun(first.id);
      expect(reloaded?.startCommit).toBe(originalCommit);
      expect(reloaded?.steps.find((s) => s.id === 'continue-1')).toMatchObject({
        startCommit: continuedCommit, harnessVersion: first.harnessVersion,
      });
      expect(step?.taskStats?.requests).toBeGreaterThan(0);
      expect(reloaded?.steps.find((s) => s.id === 'continue-1')?.taskStats).toEqual(step?.taskStats);
      const app = createApp({ repoRoot, store, manager, version: 'test' });
      const response = await apiRequest(app, `/api/v1/runs/${first.id}/metrics`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        runId: first.id, startCommit: originalCommit,
        requests: first.steps[0]!.taskStats!.requests + step!.taskStats!.requests,
      });
      expect(step?.sessionId).not.toBe(oldSession);
      const events = store.readEvents(first.id).filter((e) => e.stepId === 'continue-1');
      expect(events.filter((e) => e.type === 'error' || e.type === 'session.error')).toEqual([]);
      // The dead attempt's turn bookkeeping never reached the thread: one message, one turn.
      expect(events.filter((e) => e.type === 'user-message')).toHaveLength(1);
      expect(events.filter((e) => e.type === 'turn.started')).toHaveLength(1);
      // Verbatim: an id in the text would reach the thread as `[REDACTED]` (secret redaction).
      expect(events.some((e) => e.type === 'note' && e.message === MISSING_SESSION_NOTE)).toBe(true);
    } finally {
      delete process.env.CEZ_MOCK_MISSING_SESSIONS;
    }
  }, 30_000);

  it('session.continue on a pruned Claude session reruns the node in a fresh session', async () => {
    const argsFile = join(repoRoot, 'mock-args.ndjson');
    process.env.CEZ_MOCK_ARGS_FILE = argsFile;
    // Every resume answers "No conversation found", like a transcript past cleanupPeriodDays.
    process.env.CEZ_MOCK_MISSING_SESSIONS = '*';
    try {
      const final = await settle(
        manager.startRun(def(REVIEW_FLOW('review it mock:verdict=changes')), { task: 'x', worktree: false }).id,
      );
      expect(final.status).not.toBe('failed');
      const byId = new Map(final.steps.map((s) => [s.id, s]));
      expect(byId.get('fix')?.status).toBe('done');
      // The resume was attempted, then replaced by a session of fix's own.
      const spawns = readFileSync(argsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]);
      expect(spawns.filter((a) => a.includes('--resume')).map((a) => a[a.indexOf('--resume') + 1])).toEqual([
        byId.get('implement')?.sessionId,
      ]);
      expect(byId.get('fix')?.sessionId).toBeDefined();
      expect(byId.get('fix')?.sessionId).not.toBe(byId.get('implement')?.sessionId);
      const fixEvents = store.readEvents(final.id).filter((e) => e.stepId === 'fix');
      expect(fixEvents.filter((e) => e.type === 'error' || e.type === 'session.error')).toEqual([]);
      expect(fixEvents.some((e) => e.type === 'note' && String(e.message).includes('fresh session'))).toBe(true);
      expect(vi.mocked(track)).toHaveBeenCalledWith('session_resume_fallback', { label: 'recovered' });
    } finally {
      delete process.env.CEZ_MOCK_ARGS_FILE;
      delete process.env.CEZ_MOCK_MISSING_SESSIONS;
    }
  }, 30_000);

  it('loads a version: 2 file from .ai/cezar/workflows beside v1 files', async () => {
    const dir = join(repoRoot, '.ai/cezar/workflows');
    await run('mkdir', ['-p', dir]);
    writeFileSync(
      join(dir, 'graph.yaml'),
      [
        'version: 2',
        'name: graph-flow',
        'nodes:',
        '  - { id: start, type: start }',
        '  - { id: work, type: agent, prompt: "{{task}}" }',
        '  - { id: verify, type: check, command: "true" }',
        'edges:',
        '  - { from: start, to: work }',
        '  - { from: work.done, to: verify }',
      ].join('\n'),
    );
    writeFileSync(join(dir, 'broken.yaml'), 'version: 2\nname: broken\nnodes:\n  - { id: a, type: agent }\nedges: []\n');
    const { workflows, issues } = await loadWorkflows(repoRoot);
    const graph = workflows.find((w) => w.name === 'graph-flow');
    expect(graph?.steps.map((s) => s.id)).toEqual(['work', 'verify']);
    expect(graph?.graph?.nodes).toHaveLength(3);
    expect(issues.map((i) => i.message).join()).toMatch(/exactly one start node/);
    expect(workflows.some((w) => w.name === 'quick-task')).toBe(true);
  });
});
