import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { JUDGE_OUTAGE_RETRY_MS } from './evaluate.ts';
import { JudgeQueue } from './queue.ts';
import { readRunScores, writeRunScore } from './store.ts';

it('runs one newest-ready judge at a time and backs off when the endpoint fails', async () => {
  vi.useFakeTimers();
  const queue = new JudgeQueue();
  try {
    const old = vi.fn().mockResolvedValue({ status: 'error', reason: 'test end' });
    const first = vi.fn().mockResolvedValueOnce({ status: 'unavailable' }).mockResolvedValue({ status: 'error', reason: 'test end' });
    const oldUpdate = vi.fn();
    const firstUpdate = vi.fn();
    const now = Date.now();
    queue.enqueue({ id: 'old', finishedAt: now - 1, retryAt: now, outages: 0, evaluate: old, update: oldUpdate });
    queue.enqueue({ id: 'new', finishedAt: now, retryAt: now, outages: 0, evaluate: first, update: firstUpdate });
    expect(queue.enqueue({ id: 'new', finishedAt: now, retryAt: now, outages: 0, evaluate: first, update: firstUpdate })).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    expect(first.mock.invocationCallOrder[0]).toBeLessThan(old.mock.invocationCallOrder[0]!);
    expect(first).toHaveBeenCalledTimes(1);
    expect(old).toHaveBeenCalledTimes(1);
    expect(firstUpdate).toHaveBeenCalledWith({ status: 'pending', outages: 1, retryAt: now + JUDGE_OUTAGE_RETRY_MS[0] });
    await vi.advanceTimersByTimeAsync(JUDGE_OUTAGE_RETRY_MS[0]);
    expect(first).toHaveBeenCalledTimes(2);
  } finally {
    queue.dispose();
    vi.useRealTimers();
  }
});

it('keeps the other scorers when a single result is replaced', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cez-score-store-'));
  const at = '2026-01-01T00:00:00.000Z';
  try {
    expect(readRunScores(dir, 'fixture')).toEqual({});
    writeRunScore(dir, 'fixture', 'example', { status: 'pending', finishedAt: at, retryAt: at, outages: 0 });
    writeRunScore(dir, 'fixture', 'another', { status: 'error', finishedAt: at, reason: 'too large' });
    writeRunScore(dir, 'fixture', 'example', { status: 'scored', finishedAt: at, score: {
      scorer: 'example', label: 'pass', score: 1, pass: true, reasoning: 'fixture evidence', evidence: [], causes: [],
      judge: { runner: 'codex', transcriptChars: 100, shortened: false }, at,
    } });
    expect(readRunScores(dir, 'fixture')).toMatchObject({
      example: { status: 'scored', score: { pass: true } },
      another: { status: 'error', reason: 'too large' },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('prioritizes core results across recent runs before secondary scorers', async () => {
  vi.useFakeTimers();
  const queue = new JudgeQueue();
  try {
    const order: string[] = [];
    const now = Date.now();
    const add = (id: string, age: number, core = false) => queue.enqueue({
      id, finishedAt: now - age, retryAt: now, outages: 0, core,
      evaluate: async () => { order.push(id); return { status: 'error', reason: 'fixture' }; },
      update: () => undefined,
    });
    add('new-scope', 0);
    add('older-efficiency', 15_000, true);
    add('new-outcome', 0, true);
    add('backlog-outcome', 70_000, true);
    await vi.advanceTimersByTimeAsync(20);
    expect(order).toEqual(['new-outcome', 'older-efficiency', 'new-scope', 'backlog-outcome']);
  } finally {
    queue.dispose();
    vi.useRealTimers();
  }
});
