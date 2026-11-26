import { describe, expect, it, vi } from 'vitest';
import { buildClaudeArgs } from '../core/claude-cli-runner.ts';
import { opencodeReadOnlyConfig } from '../core/private-mcp.ts';
import { summarizeRunMetrics } from '../runs/task-metrics.ts';
import type { RunEvent, RunRecord } from '../runs/store.ts';
import type { Scorer } from '../factory/scorers.ts';
import { evaluateScorer, JUDGE_TIMEOUT_MS } from './evaluate.ts';
import { renderJudgeTranscript } from './transcript.ts';
import { validateJudgeReply } from './verdict.ts';

const stamp = '2026-01-01T00:00:01.000Z';
const run: RunRecord = {
  id: 'example-run', workflow: 'implement', title: 'Example task', task: 'Preserve the complete brief.',
  status: 'done', archived: false, createdAt: stamp, tokensUsed: 0, steps: [],
};
const scorer: Scorer = {
  name: 'example', description: 'Test judge', rubric: 'Quote evidence.', passingScore: 1, samplingRate: 100, source: 'project',
  labels: [{ value: 'pass', score: 1, description: 'passed' }, { value: 'fail', score: 0.5, description: 'failed' }],
};
const event = (seq: number, type: string, fields: Record<string, unknown>): RunEvent => ({ seq, ts: stamp, stepId: 'work', type, ...fields });

describe('judge inputs and validation', () => {
  it('keeps both local judge runner toolsets disabled', () => {
    const args = buildClaudeArgs({ cwd: '/tmp', userPrompt: 'Judge the task', noTools: true, allowedTools: ['Read'] });
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args).toContain('--strict-mcp-config');
    expect(args).not.toContain('--allowedTools');

    const config = JSON.parse(opencodeReadOnlyConfig(JSON.stringify({
      default_agent: 'custom', agent: { custom: { permission: { bash: 'allow' } } },
    }), true));
    expect(config).toMatchObject({
      default_agent: 'build', permission: { '*': 'deny' },
      agent: { build: { permission: { '*': 'deny' } }, custom: { permission: { '*': 'deny' } } },
    });
  });

  it('shortens the largest tool output and keeps all messages and call arguments', () => {
    const events = [
      event(1, 'text', { text: 'Starting with the checklist.' }),
      event(2, 'tool-call', { id: 'first', tool: 'Read', input: { path: 'example.md' } }),
      event(3, 'tool-result', { toolCallId: 'first', result: 'headmarker' + 'x'.repeat(10_000) + 'tailmarker' }),
      event(4, 'tool-call', { id: 'second', tool: 'Bash', input: { command: 'echo complete' } }),
      event(5, 'tool-result', { toolCallId: 'second', result: 'complete' }),
      event(6, 'user-message', { text: 'Please verify the output.' }),
      event(7, 'text', { text: 'Verified the output.' }),
    ];
    const metrics = summarizeRunMetrics(run, events);
    const report = renderJudgeTranscript(run, metrics, events, 2300);
    expect(report).toHaveProperty('shortened', true);
    if ('error' in report) throw new Error(report.error);
    expect(report.text.length).toBeLessThanOrEqual(2300);
    for (const text of ['Preserve the complete brief.', 'Starting with the checklist.', 'example.md', 'headmarker',
      'tailmarker', 'chars cut', 'echo complete', 'complete', 'Please verify the output.', '## Final message\nVerified the output.']) {
      expect(report.text).toContain(text);
    }
    expect(renderJudgeTranscript(run, metrics, events, 200)).toEqual({ error: 'too large' });
  });

  it('retries malformed replies with the validation reason and lets the queue handle outages', async () => {
    const transcript = { text: 'One observed failure.', shortened: false };
    const call = vi.fn()
      .mockResolvedValueOnce({ text: 'garbled' })
      .mockResolvedValueOnce({ text: JSON.stringify({ label: 'pass', reasoning: 'Conforms' }) });
    const result = await evaluateScorer(scorer, transcript, call);
    expect(result).toMatchObject({ status: 'scored', verdict: { pass: true } });
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[0]?.[0]).toMatchObject({ timeoutMs: JUDGE_TIMEOUT_MS, userPrompt: transcript.text });
    expect(call.mock.calls[1]?.[0].systemPrompt).toContain('The previous reply was rejected: Reply must be a single JSON object.');

    call.mockClear().mockResolvedValue({ unavailable: true });
    expect(await evaluateScorer(scorer, transcript, call)).toEqual({ status: 'unavailable' });
    expect(call).toHaveBeenCalledTimes(1);
    call.mockClear().mockResolvedValue({ timedOut: true });
    expect(await evaluateScorer(scorer, transcript, call)).toEqual({ status: 'error', reason: 'The judge exceeded the reply timeout.' });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('derives the score from the rubric, caps causes and rejects unsupported evidence', () => {
    const cause = { category: 'repository', target: 'docs', evidence: 'Exact quote', fix: 'Document the behavior.' };
    const reply = {
      label: 'fail', reasoning: 'The change omitted instructions.', evidence: ['Invented', 'Exact quote'],
      causes: [{ ...cause, evidence: 'Invented' }, { ...cause, evidence: undefined }, cause, cause, cause, cause],
    };
    expect(validateJudgeReply(JSON.stringify(reply), scorer, 'The transcript includes Exact quote.')).toEqual({
      label: 'fail', score: 0.5, pass: false, reasoning: reply.reasoning, evidence: ['Exact quote'], causes: [cause, cause, cause],
    });
    expect(validateJudgeReply(JSON.stringify({ ...reply, label: 'unknown' }), scorer, '')).toHaveProperty('error');
    expect(validateJudgeReply('not JSON', scorer, '')).toHaveProperty('error');
  });
});
