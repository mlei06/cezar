import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunResult, AgentRunSpec, RunnerId } from '../core/agent-runner.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager, replayMode } from './run.ts';
import { buildClaudeArgs } from '../core/claude-cli-runner.ts';
import { graphToSteps, type WorkflowGraph } from './graph.ts';
import { PLAN, REVIEW_PR } from './templates.ts';
import { GIT_SHOW_AT_REF } from '../core/read-grants.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

const captured = vi.hoisted(() => ({ launches: [] as Array<{ backend: string; spec: AgentRunSpec }> }));

// Capture supported launches and use the real factory guard for the unsupported backend.
vi.mock('../core/runner-factory.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/runner-factory.ts')>();
  return { ...actual, createRunner: (backend: RunnerId) => backend === 'kimi' ? actual.createRunner(backend) : ({
    backend,
    run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }),
    startSession: (spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void) => {
      captured.launches.push({ backend, spec });
      return {
        result: new Promise<AgentRunResult>((resolve) => {
          setTimeout(() => {
            onEvent?.({ type: 'session', sessionId: `sess-${captured.launches.length}` });
            const text = 'ok\n\nCEZ:VERDICT approve';
            onEvent?.({ type: 'text', text });
            onEvent?.({ type: 'turn-end' });
            resolve({ text, toolCalls: [], tokensUsed: 0 });
          }, 0);
        }),
        sendMessage: () => false,
        end: () => {},
        interrupt: () => {},
        open: false,
      };
    },
    interrupt: async () => {},
  }) };
});

/** The read-only `review-pr` workflow keeps its tool limits on every launch, or does not launch. */
describe('a read-only workflow', { timeout: 30_000 }, () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;

  beforeEach(async () => {
    captured.launches.length = 0;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-read-only-workflow-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    writeFileSync(join(repoRoot, '.gitignore'), '.ai/\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai/cezar/mcp.local.json'), JSON.stringify({ mcpServers: { tracker: { command: 'tracker-mcp' } } }));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterEach(() => {
    manager?.dispose();
    manager = undefined;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const terminal = (id: string) =>
    vi.waitFor(() => expect(['done', 'review', 'failed', 'cancelled']).toContain(store.getRun(id)?.status), { timeout: 20_000 });

  it('enforces plan policy at launch and Continue', async () => {
    writeFileSync(join(repoRoot, '.ai/cezar/config.json'), JSON.stringify({ defaultRunner: 'codex' }));
    const id = manager!.startRun(PLAN, { task: 'inspect the repo' }).id;
    await terminal(id);
    expect(store.getRun(id)?.status, store.getRun(id)?.error).not.toBe('failed');
    expect(manager!.continueRun(id, { text: 'investigate further', runner: 'codex' })).toEqual({ ok: true });
    await vi.waitFor(() => expect(captured.launches).toHaveLength(2), { timeout: 15_000 });
    await terminal(id);
    for (const { backend, spec } of captured.launches) {
      expect(backend).toBe('codex');
      expect(spec).toMatchObject({
        enforceReadOnly: true, allowedTools: ['Read', 'Grep', 'Glob', 'Bash'], bashAllowlist: [GIT_SHOW_AT_REF], mcpServers: [],
        env: { GH_TOKEN: '', GITHUB_TOKEN: '', GIT_TERMINAL_PROMPT: '0' },
      });
      expect(spec.bypassPermissions).toBeUndefined();
    }
  });

  it('refuses plan launch and Continue when the selected backend cannot enforce read-only mode', async () => {
    const graph: WorkflowGraph = {
      ...PLAN.graph!,
      nodes: PLAN.graph!.nodes.map((node) => node.type === 'agent' ? { ...node, runner: 'kimi', model: undefined } : node),
    };
    const first = manager!.startRun({ ...PLAN, graph, steps: graphToSteps(graph) }, { task: 'inspect' }).id;
    await terminal(first);
    expect(store.getRun(first)?.error).toContain('kimi cannot keep a read-only task');
    expect(store.getRun(first)?.steps[0]?.sessionId).toBeUndefined();

    const second = manager!.startRun(PLAN, { task: 'inspect' }).id;
    await terminal(second);
    expect(manager!.continueRun(second, { text: 'investigate further', runner: 'kimi' })).toEqual({ ok: true });
    await vi.waitFor(() => {
      expect(store.readEvents(second).some((event) =>
        JSON.stringify(event).includes('kimi cannot keep a read-only task'))).toBe(true);
    }, { timeout: 15_000 });
    expect(store.getRun(second)?.steps.at(-1)?.sessionId).toBeUndefined();
  });

  it('keeps Plan\'s shell denied on Claude, and drops the Codex grant when a Codex Plan continues there', async () => {
    const id = manager!.startRun(PLAN, { task: 'inspect the repo', runner: 'codex' }).id;
    await terminal(id);
    expect(manager!.continueRun(id, { text: 'investigate further', runner: 'claude' })).toEqual({ ok: true });
    await vi.waitFor(() => expect(captured.launches).toHaveLength(2), { timeout: 15_000 });
    await terminal(id);
    const second = manager!.startRun(PLAN, { task: 'inspect the repo', runner: 'claude' }).id;
    await vi.waitFor(() => expect(captured.launches).toHaveLength(3), { timeout: 15_000 });
    await terminal(second);
    expect(captured.launches.map(({ backend }) => backend)).toEqual(['codex', 'claude', 'claude']);
    for (const { spec } of captured.launches.slice(1)) {
      expect(spec).toMatchObject({ enforceReadOnly: true, allowedTools: ['Read', 'Grep', 'Glob'], mcpServers: [] });
      expect(spec.bashAllowlist).toBeUndefined();
      expect(spec.bypassPermissions).toBeUndefined();
      // Claude's own read-only denial of Bash stays in force.
      const args = buildClaudeArgs(spec);
      expect(args[args.indexOf('--disallowedTools') + 1]!.split(',')).toContain('Bash');
      expect(args[args.indexOf('--allowedTools') + 1]).toBe('Read,Grep,Glob');
    }
  });

  it('attaches the grant at execution only: the saved Plan definition is unchanged and still replays', async () => {
    const id = manager!.startRun(PLAN, { task: 'inspect the repo', runner: 'codex' }).id;
    await terminal(id);
    const record = store.getRun(id)!;
    expect(record.steps[0]?.toolPolicy).toMatchObject({ allowedTools: ['Read', 'Grep', 'Glob', 'Bash'], bashAllowlist: [GIT_SHOW_AT_REF] });
    const work = record.workflowDef!.graph!.nodes.find((node) => node.id === 'work')!;
    expect(work).toMatchObject({ allowedTools: ['Read', 'Grep', 'Glob'] });
    expect(work).not.toHaveProperty('bashAllowlist');
    expect(record.workflowDef!.steps.every((step) => step.bashAllowlist === undefined)).toBe(true);
    expect(replayMode(record.workflowDef!)).toBe('agent');
  });

  it('drops the grant name from any other workflow that names it', async () => {
    const graph: WorkflowGraph = {
      ...PLAN.graph!,
      nodes: PLAN.graph!.nodes.map((node) => node.type === 'agent' ? { ...node, allowedTools: ['Read', 'Bash'], bashAllowlist: [GIT_SHOW_AT_REF] } : node),
    };
    manager!.startRun({ ...PLAN, name: 'custom-plan', source: 'file', graph, steps: graphToSteps(graph) }, { task: 'inspect', runner: 'codex' });
    await vi.waitFor(() => expect(captured.launches).toHaveLength(1), { timeout: 15_000 });
    expect(captured.launches[0]!.spec.allowedTools).toEqual(['Read']);
    expect(captured.launches[0]!.spec.bashAllowlist).toBeUndefined();
  });

  it('launches on Claude with a read-only shell and no private MCP', async () => {
    manager!.startRun(REVIEW_PR, { task: 'https://github.com/o/r/pull/1', runner: 'claude' });
    await vi.waitFor(() => expect(captured.launches.length).toBeGreaterThan(0), { timeout: 15_000 });
    const { spec } = captured.launches[0]!;
    expect(spec.allowedTools).toEqual(['Read', 'Grep', 'Glob', 'Bash']);
    expect(spec.bashAllowlist).toContain('gh pr diff');
    expect(spec.bashAllowlist).not.toContain('git push');
    expect(spec.mcpServers).toEqual([]);
  });

  it('passes the owning step limits to isolated Codex on launch and Continue', async () => {
    const id = manager!.startRun(REVIEW_PR, { task: 'https://github.com/o/r/pull/1', runner: 'codex' }).id;
    await terminal(id);
    expect(store.getRun(id)?.status, store.getRun(id)?.error).not.toBe('failed');
    const before = captured.launches.filter(l => l.backend === 'codex').length;
    manager!.continueRun(id, { text: 'now push it', runner: 'codex' });
    await vi.waitFor(() => expect(captured.launches.filter(l => l.backend === 'codex').length).toBeGreaterThan(before), { timeout: 15_000 });
    await terminal(id);
    const launches = captured.launches.filter(l => l.backend === 'codex');
    expect(launches.length).toBeGreaterThan(1);
    for (const { spec } of launches) {
      expect(spec.allowedTools).toEqual(['Read', 'Grep', 'Glob', 'Bash']);
      expect(spec.bashAllowlist).toContain('gh pr diff');
      expect(spec.bashAllowlist).not.toContain('git push');
      expect(spec.mcpServers).toEqual([]);
    }
  });

  it('refuses a backend that ignores tool limits, before spawning it', async () => {
    const id = manager!.startRun(REVIEW_PR, { task: 'https://github.com/o/r/pull/1', runner: 'opencode' }).id;
    await terminal(id);
    // By backend: a previous case's disposed run may still land a late launch of its own.
    expect(captured.launches.filter((l) => l.backend === 'opencode')).toEqual([]);
    expect(store.getRun(id)?.status).toBe('failed');
    expect(readFileSync(join(repoRoot, '.ai/cezar/runs', `${id}.ndjson`), 'utf8')).toContain('opencode does not enforce');
  });

  it('refuses a Continue on such a backend too', async () => {
    const id = manager!.startRun(REVIEW_PR, { task: 'https://github.com/o/r/pull/1', runner: 'claude' }).id;
    await terminal(id);
    manager!.continueRun(id, { text: 'now push it', runner: 'opencode' });
    await vi.waitFor(() => expect(readFileSync(join(repoRoot, '.ai/cezar/runs', `${id}.ndjson`), 'utf8')).toContain('opencode does not enforce'), { timeout: 15_000 });
    expect(captured.launches.filter((l) => l.backend === 'opencode')).toEqual([]);
  });
});
