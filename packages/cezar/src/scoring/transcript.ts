import type { RunMetrics } from '@open-mercato/cezar-contract';
import type { RunEvent, RunRecord } from '../runs/store.ts';
import { stripTaskMarkers } from '../runs/task-markers.ts';

type TranscriptPart = { text: string; output?: string };
export type JudgeTranscript = { text: string; shortened: boolean } | { error: 'too large' };

function elapsed(ts: string, start: number): string {
  const seconds = Math.max(0, Math.floor((Date.parse(ts) - start) / 1000));
  if (!Number.isFinite(seconds)) return '?:??';
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function shortenOutput(output: string, kept: number): string {
  const tail = Math.ceil(kept / 4);
  const head = kept - tail;
  return `${output.slice(0, head)} … [${output.length - kept} chars cut] … ${output.slice(-tail)}`;
}

/** Keep the whole brief, metrics and each message or call. Only tool output text can be cut. */
export function renderJudgeTranscript(
  run: RunRecord,
  metrics: RunMetrics,
  events: readonly RunEvent[],
  maxChars: number,
): JudgeTranscript {
  const start = Date.parse(run.startedAt ?? run.createdAt);
  const headings = [
    `# Run ${run.id.slice(0, 8)}: ${run.titleSummary ?? run.title}`,
    [run.workflow, metrics.runner, metrics.model, `started by ${metrics.startedBy}`, run.status, run.pullRequestUrl].filter(Boolean).join(' · '),
    '## Brief', run.task,
    '## Metrics', JSON.stringify(metrics, null, 2),
    '## Transcript',
  ].join('\n');
  const parts: TranscriptPart[] = [{ text: headings }];
  const calls = new Map<string, { tool: string; at: number }>();
  let final: string | undefined;
  for (const event of events) {
    const prefix = `[+${elapsed(event.ts, start)}]`;
    const key = (id: string) => `${event.stepId ?? ''}/${id}`;
    switch (event.type) {
      case 'text':
        if (typeof event.text === 'string') {
          const text = stripTaskMarkers(event.text);
          parts.push({ text: `${prefix} assistant: ${text}` });
          if (text.trim()) final = text;
        }
        break;
      case 'user-message':
        if (typeof event.text === 'string') parts.push({ text: `${prefix} user said: ${event.text}` });
        break;
      case 'tool-call':
        if (typeof event.id === 'string' && typeof event.tool === 'string') {
          calls.set(key(event.id), { tool: event.tool, at: Date.parse(event.ts) });
          parts.push({ text: `${prefix} tool ${event.tool}: ${JSON.stringify(event.input ?? {})}` });
        }
        break;
      case 'tool-result':
        if (typeof event.result === 'string' && typeof event.toolCallId === 'string') {
          const call = calls.get(key(event.toolCallId));
          const duration = call && Date.parse(event.ts) - call.at;
          const durationLabel = duration !== undefined && Number.isFinite(duration) && duration >= 0 ? `${(duration / 1000).toFixed(1)} s, ` : '';
          parts.push({ text: `${prefix} ${call?.tool ?? 'tool'} result (${durationLabel}${event.result.length} chars):`, output: event.result });
          calls.delete(key(event.toolCallId));
        }
        break;
      case 'check-output':
        if (typeof event.text === 'string') {
          parts.push({ text: `${prefix} check ${String(event.command ?? event.stepId ?? '')} (exit ${String(event.exitCode ?? '?')}):`, output: event.text });
        }
        break;
    }
  }
  if (final) parts.push({ text: `## Final message\n${final}` });
  const render = () => parts.map(({ text, output }) => output === undefined ? text : `${text}\n${output}`).join('\n');
  const length = () => parts.reduce((sum, part) => sum + part.text.length + (part.output === undefined ? 0 : part.output.length + 1), parts.length - 1);
  let excess = length() - maxChars;
  const shortened = excess > 0;
  if (shortened) {
    const candidates = parts.filter((part) => part.output !== undefined).sort((a, b) => b.output!.length - a.output!.length);
    for (const part of candidates) {
      if (excess <= 0) break;
      const raw = part.output!;
      const reduced = shortenOutput(raw, Math.max(16, raw.length - excess - 32));
      if (reduced.length >= raw.length) continue;
      part.output = reduced;
      excess -= raw.length - reduced.length;
    }
  }
  return excess > 0 ? { error: 'too large' } : { text: render(), shortened };
}
