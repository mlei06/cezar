import { describe, expect, it } from 'vitest';
import { runMetricsSchema } from '@open-mercato/cezar-contract';
import { summarizeRunMetrics, summarizeTaskEvents } from './task-metrics.ts';
import type { RunEvent, RunRecord } from './store.ts';

const base = Date.parse('2026-01-01T00:00:00Z');
const at = (ms: number) => new Date(base + ms).toISOString();
const event = (seq: number, ms: number, type: string, fields: Record<string, unknown>): RunEvent =>
  ({ seq, ts: at(ms), stepId: 'work', type, ...fields });

describe('task metrics', () => {
  it('ranks recorded tool output and measures concurrent durations once', () => {
    const report = summarizeTaskEvents([
      event(1, 0, 'turn.started', { turnId: 't' }),
      event(2, 200, 'tool-call', { id: '1', tool: 'Bash' }),
      event(3, 400, 'tool-call', { id: '2', tool: 'Read' }),
      event(4, 1000, 'tool-result', { toolCallId: '2', result: 'b'.repeat(77_000) }),
      event(5, 1300, 'tool-result', { toolCallId: '1', result: 'first' }),
      event(6, 2000, 'turn.completed', { turnId: 't', usage: { cacheRead: 90 } }),
      event(7, 2100, 'turn.completed', { turnId: 't', usage: { cacheRead: 90 } }),
      event(8, 2500, 'tool-call', { id: '3', tool: 'Read' }),
    ]);
    expect(report).toMatchObject({
      modelMs: 900, toolMs: 1100, toolCalls: 3, toolResultChars: 77_005, cacheRead: 90,
      largestOutputs: [{ call: 2, chars: 77_000, head: 'b'.repeat(160) }, { call: 1, chars: 5 }],
      longestCalls: [{ call: 1, ms: 1100 }, { call: 2, ms: 600 }],
    });
  });

  it('aggregates measured context samples and leaves older records readable', () => {
    const run: RunRecord = {
      id: 'fixture', title: 'Fixture', task: 't', workflow: 'example', status: 'done', archived: false,
      createdAt: at(0), startedAt: at(1000), finishedAt: at(4000), steps: [], tokensUsed: 0,
    };
    const legacy = summarizeRunMetrics(run, []);
    expect(runMetricsSchema.parse(legacy)).toMatchObject({ wallMs: 3000, toolCalls: 0, startedBy: 'owner' });
    expect(legacy.requests).toBeUndefined();
    run.steps.push({
      id: 'work', name: 'Work', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0,
      taskStats: { requests: 3, contextFirst: 80_000, contextTotal: 279_000, contextPeak: 100_000,
        toolCalls: 0, toolResultChars: 0, cacheReadTokens: 13 },
    });
    expect(runMetricsSchema.parse(summarizeRunMetrics(run, []))).toMatchObject({
      requests: 3, contextAvg: 93_000, contextPeak: 100_000, tokens: { cacheRead: 13 },
    });
  });
});
