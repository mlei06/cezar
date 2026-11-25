import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

/** The graph-workflow routes (spec 2026-09-30-workflow-node-editor, phase 1b). */
describe('the workflow graph API', () => {
  let repoRoot: string;
  let store: RunStore;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-graph-api-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
  });
  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const app = () => createApp({ repoRoot, store, manager: {} as RunManager, version: 'test' });
  const post = (path: string, body: unknown) =>
    apiRequest(app(), path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  const GRAPH = {
    nodes: [
      { id: 'start', type: 'start' },
      { id: 'work', type: 'agent', prompt: '{{task}}' },
      { id: 'review', type: 'agent', skill: 'code-review', verdicts: ['approve', 'changes'] },
      { id: 'tests', type: 'check', command: 'npm test' },
    ],
    edges: [
      { from: 'start', to: 'work' },
      { from: 'work', to: 'review' },
      { from: 'review.approve', to: 'tests' },
    ],
    layout: { work: { x: 10, y: 20 } },
  };

  it('serves the node catalog', async () => {
    const res = await apiRequest(app(), '/api/v1/workflows/nodes');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nodes: { type: string; ports: string[] }[] };
    expect(body.nodes.map((n) => n.type)).toEqual([
      'start',
      'end',
      'loop',
      'agent',
      'check',
      'gate.human',
      'ask-user',
      'dispatch',
      'git.commit',
      'github.draft-pr',
      'github.wait-ci',
      'github.pr-comment',
      'fork',
      'join',
      'if',
      'git.push',
      'git.sync-base',
      'github.pr-update',
      'github.issue-comment',
      'notify.webhook',
      'workflow',
    ]);
    expect(body.nodes.find((n) => n.type === 'loop')?.ports).toEqual(['repeat', 'exhausted']);
  });

  it('validates: [] for a sound graph, issues for an unsound one, 400 for a non-graph', async () => {
    expect(await (await post('/api/v1/workflows/validate', { graph: GRAPH })).json()).toEqual({ issues: [] });
    const cyclic = { ...GRAPH, edges: [...GRAPH.edges, { from: 'tests.fail', to: 'work' }] };
    const res = await post('/api/v1/workflows/validate', { graph: cyclic });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { issues: string[] }).issues.join()).toMatch(/does not pass a loop node/);
    expect((await post('/api/v1/workflows/validate', { graph: { nodes: 'x' } })).status).toBe(400);
  });

  it('saves a version: 2 file (409 without overwrite), and the catalog loads it back', async () => {
    const created = await post('/api/v1/workflows/graph', { name: 'Review Flow', graph: GRAPH });
    expect(created.status).toBe(201);
    const { path } = (await created.json()) as { path: string };
    expect(path.endsWith('.ai/cezar/workflows/review-flow.yaml')).toBe(true);
    expect(parseYaml(readFileSync(path, 'utf8'))).toMatchObject({ version: 2, name: 'Review Flow', layout: GRAPH.layout });

    const again = await post('/api/v1/workflows/graph', { name: 'Review Flow', graph: GRAPH });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ exists: true });
    expect((await post('/api/v1/workflows/graph', { name: 'Review Flow', graph: GRAPH, overwrite: true })).status).toBe(201);

    const catalog = (await (await apiRequest(app(), '/api/v1/workflows')).json()) as {
      workflows: { name: string; steps: { id: string }[]; graph?: unknown }[];
    };
    const loaded = catalog.workflows.find((w) => w.name === 'Review Flow');
    expect(loaded?.steps.map((s) => s.id)).toEqual(['work', 'review', 'tests']);
    expect(loaded?.graph).toMatchObject({ nodes: GRAPH.nodes, edges: GRAPH.edges });
  });

  it.each([1, 2])('round-trips a v%i budget and agent allowlist through YAML, API and catalog', async (version) => {
    const budget = { tokens: 800_000, minutes: 20 };
    const steps = [
      { id: 'work', skill: 'build', prompt: '{{task}}', secrets: [] },
      { id: 'review', skill: 'review', prompt: '{{task}}', secrets: ['REVIEW_KEY'] },
    ];
    const graph = {
      nodes: [{ id: 'start', type: 'start' }, ...steps.map((step) => ({ ...step, type: 'agent' }))],
      edges: GRAPH.edges.slice(0, 2),
    };
    const input = { name: 'Budgeted', budget, ...(version === 2 ? { graph } : { steps }) };
    const created = await post(version === 2 ? '/api/v1/workflows/graph' : '/api/v1/workflows', input);
    expect(created.status).toBe(201);
    const { path } = await created.json() as { path: string };
    const yaml = readFileSync(path, 'utf8');
    expect(parseYaml(yaml)).toMatchObject({ budget, ...(version === 2 ? { nodes: graph.nodes } : { steps }) });

    const imported = await post('/api/v1/workflows/parse', { yaml });
    expect(imported.status).toBe(200);
    expect(await imported.json()).toMatchObject({ budget, steps });
    const catalog = await (await apiRequest(app(), '/api/v1/workflows')).json() as {
      workflows: { name: string }[];
    };
    expect(catalog.workflows.find((workflow) => workflow.name === input.name)).toMatchObject({ budget, steps });
  });

  it.each([{}, { tokens: 0 }, { tokens: 1.5 }, { minutes: -1 }, { minutes: '20' }, { usd: 1 }])(
    'rejects invalid workflow budget %j in both formats',
    async (budget) => {
      const name = 'bad-budget';
      expect((await post('/api/v1/workflows', { name, skills: ['build'], budget })).status).toBe(400);
      expect((await post('/api/v1/workflows/graph', { name, graph: GRAPH, budget })).status).toBe(400);
      for (const doc of [{ name, skills: ['build'], budget }, { name, version: 2, ...GRAPH, budget }]) {
        expect((await post('/api/v1/workflows/parse', { yaml: stringifyYaml(doc) })).status).toBe(400);
      }
    },
  );

  it('refuses to save an unsound graph', async () => {
    const res = await post('/api/v1/workflows/graph', { name: 'bad', graph: { ...GRAPH, nodes: GRAPH.nodes.slice(1) } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/exactly one start node/);
  });

  it('parses pasted v2 YAML into steps + graph, and v1 YAML exactly as before', async () => {
    const v2 = await post('/api/v1/workflows/parse', { yaml: stringifyYaml({ version: 2, name: 'g', ...GRAPH }) });
    expect(v2.status).toBe(200);
    const body = (await v2.json()) as { steps: { id: string }[]; graph?: unknown };
    expect(body.steps.map((s) => s.id)).toEqual(['work', 'review', 'tests']);
    expect(body.graph).toBeDefined();

    const v1 = await post('/api/v1/workflows/parse', { yaml: 'name: s\nskills: [a, b]\n' });
    expect(await v1.json()).toEqual({
      name: 's',
      steps: [
        { id: 'a', name: 'a', skill: 'a', prompt: '{{task}}' },
        { id: 'b', name: 'b', skill: 'b', prompt: '{{task}}' },
      ],
    });
  });
});
