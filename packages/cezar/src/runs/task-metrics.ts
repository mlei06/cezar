import type { RunMetrics, TaskTurnStats } from '@open-mercato/cezar-contract';
import { addTaskTurnStats } from '../managers/turn-stats.ts';
import type { RunEvent, RunRecord } from './store.ts';

type Span = { start: number; end: number };
type ToolCall = { call: number; tool: string; start: number };
const TOP_COUNT = 5;
const HEAD_LIMIT = 160;

function union(spans: Span[]): Span[] {
  const result: Span[] = [];
  for (const span of spans.sort((a, b) => a.start - b.start)) {
    if (span.end <= span.start) continue;
    const last = result.at(-1);
    if (last && last.end >= span.start) last.end = Math.max(last.end, span.end);
    else result.push({ ...span });
  }
  return result;
}

function duration(spans: Span[]): number {
  return spans.reduce((sum, span) => sum + span.end - span.start, 0);
}

function overlap(left: Span[], right: Span[]): number {
  let ms = 0;
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const a = left[i]!;
    const b = right[j]!;
    ms += Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
    if (a.end <= b.end) i++;
    else j++;
  }
  return ms;
}

export function summarizeTaskEvents(events: readonly RunEvent[]) {
  let toolCalls = 0;
  let toolResultChars = 0;
  let cacheRead: number | undefined;
  const startedTools = new Map<string, ToolCall>();
  const startedTurns = new Map<string, number>();
  const toolSpans: Span[] = [];
  const turnSpans: Span[] = [];
  const largestOutputs: RunMetrics['largestOutputs'] = [];
  const longestCalls: RunMetrics['longestCalls'] = [];
  for (const event of events) {
    const at = Date.parse(event.ts);
    const key = (id: string) => `${event.stepId ?? ''}/${id}`;
    if (event.type === 'tool-call' && typeof event.id === 'string' && typeof event.tool === 'string') {
      const id = key(event.id);
      if (startedTools.has(id)) continue;
      startedTools.set(id, { call: ++toolCalls, tool: event.tool, start: at });
    } else if (event.type === 'tool-result' && typeof event.toolCallId === 'string' && typeof event.result === 'string') {
      const id = key(event.toolCallId);
      const call = startedTools.get(id);
      if (!call) continue;
      startedTools.delete(id);
      const head = event.result.slice(0, HEAD_LIMIT);
      const chars = event.result.length;
      toolResultChars += chars;
      largestOutputs.push({ call: call.call, tool: call.tool, head, chars });
      if (Number.isFinite(at) && Number.isFinite(call.start) && at >= call.start) {
        toolSpans.push({ start: call.start, end: at });
        longestCalls.push({ call: call.call, tool: call.tool, head, ms: at - call.start });
      }
    } else if (event.type === 'turn.started' && typeof event.turnId === 'string') {
      const id = key(event.turnId);
      if (!startedTurns.has(id) && Number.isFinite(at)) startedTurns.set(id, at);
    } else if (event.type === 'turn.completed' && typeof event.turnId === 'string') {
      const id = key(event.turnId);
      const start = startedTurns.get(id);
      if (start === undefined) continue;
      startedTurns.delete(id);
      if (Number.isFinite(at) && at >= start) turnSpans.push({ start, end: at });
      const cached = (event.usage as { cacheRead?: unknown } | undefined)?.cacheRead;
      if (typeof cached === 'number' && Number.isFinite(cached) && cached >= 0) cacheRead = (cacheRead ?? 0) + cached;
    }
  }
  const tools = union(toolSpans);
  const turns = union(turnSpans);
  return {
    toolCalls, toolResultChars, cacheRead,
    toolMs: duration(tools),
    modelMs: duration(turns) - overlap(turns, tools),
    largestOutputs: largestOutputs.sort((a, b) => b.chars - a.chars || a.call - b.call).slice(0, TOP_COUNT),
    longestCalls: longestCalls.sort((a, b) => b.ms - a.ms || a.call - b.call).slice(0, TOP_COUNT),
  };
}

/** Some runners report uncached input separately. Context samples place a lower bound on all input. */
export function measuredRunInputTokens(run: RunRecord): number | undefined {
  const measured = run.steps.flatMap((step) => {
    const directional = step.inputTokens;
    const context = step.taskStats?.requests ? step.taskStats.contextTotal : undefined;
    return directional === undefined && context === undefined ? [] : [Math.max(directional ?? 0, context ?? 0)];
  });
  if (!measured.length) return run.inputTokens;
  return Math.max(run.inputTokens ?? 0, measured.reduce((sum, count) => sum + count, 0));
}

export function summarizeRunMetrics(run: RunRecord, events: readonly RunEvent[], now = Date.now(), activeMs = run.activeMs): RunMetrics {
  const { cacheRead, ...tools } = summarizeTaskEvents(events);
  let stats: TaskTurnStats | undefined;
  for (const step of run.steps) if (step.taskStats) stats = addTaskTurnStats(stats, step.taskStats);
  const { runner, actualModel, model, startCommit, harnessVersion, budget, budgetExceeded } = run;
  const inputTokens = measuredRunInputTokens(run);
  const observedModel = actualModel ?? model;
  const cacheReadTokens = cacheRead ?? stats?.cacheReadTokens;
  const begin = Date.parse(run.startedAt ?? run.createdAt);
  const end = run.finishedAt ? Date.parse(run.finishedAt) : run.startedAt ? now : begin;
  const checks = run.steps.filter((step) => step.kind === 'check' &&
    (!run.workflowDef?.graph || run.workflowDef.graph.nodes.some((node) => node.id === step.id && node.type === 'check')));
  return {
    runId: run.id,
    workflow: run.workflow,
    ...(runner ? { runner } : {}),
    ...(observedModel ? { model: observedModel } : {}),
    startedBy: run.automation || run.automationTrigger || run.automationTracker ? 'automation' : run.startedByManager ? 'manager' : 'owner',
    ...(startCommit ? { startCommit } : {}),
    ...(harnessVersion ? { harnessVersion } : {}),
    wallMs: Number.isFinite(end - begin) ? Math.max(0, end - begin) : 0,
    ...(activeMs !== undefined ? { activeMs } : {}),
    tokens: {
      ...(inputTokens !== undefined ? { input: inputTokens } : {}),
      ...(run.outputTokens !== undefined ? { output: run.outputTokens } : {}),
      ...(cacheReadTokens !== undefined ? { cacheRead: cacheReadTokens } : {}),
    },
    ...(stats?.requests ? { requests: stats.requests, contextAvg: stats.contextTotal / stats.requests, contextPeak: stats.contextPeak } : {}),
    ...tools,
    ...(budget ? { budget } : {}),
    ...(budgetExceeded ? { budgetExceeded } : {}),
    outcome: {
      status: run.status,
      ...(run.pullRequestUrl ? { pr: run.pullRequestUrl } : {}),
      checks: {
        passed: checks.filter((step) => step.status === 'done').length,
        failed: checks.filter((step) => step.status === 'failed').length,
      },
    },
  };
}
