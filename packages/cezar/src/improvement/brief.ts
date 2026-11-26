import type { ImprovementRecord, QueuedCause } from '@open-mercato/cezar-contract';
import type { ImprovementSettings } from './settings.ts';

const DAY_MS = 86_400_000;

/**
 * The improvement run's brief (spec D6): every cause with its scorer, label, reasoning, evidence,
 * fix, run link and age, the project's improvement scope, and the previous improvements.
 */
export function buildImprovementBrief(input: {
  projectId: string;
  queue: 'project' | 'harness';
  batch: readonly QueuedCause[];
  previous: readonly ImprovementRecord[];
  settings: ImprovementSettings;
  now: Date;
}): string {
  const lines: string[] = [
    `Improvement run for ${input.queue === 'harness' ? 'the harness queue' : `project ${input.projectId}`}: ${input.batch.length} open causes.`,
    '',
    `Scope: you may change ${input.settings.scope.join(', ')}. Anything else is deferred.`,
    'Every cause below belongs to exactly one cluster in the decisions file; use its id.',
    '',
    '## Causes',
  ];
  for (const cause of input.batch) {
    const age = Math.max(0, Math.floor((input.now.getTime() - Date.parse(cause.at)) / DAY_MS));
    lines.push(
      '',
      `### ${cause.id}`,
      `- Scorer: ${cause.scorer} (${cause.label}); target: ${cause.cause.target}; category: ${cause.cause.category}; age: ${age} days`,
      `- Run: /p/${encodeURIComponent(cause.projectId)}/runs/${encodeURIComponent(cause.runId)}`,
      `- Evidence: ${oneLine(cause.cause.evidence)}`,
      `- Suggested fix: ${oneLine(cause.cause.fix)}`,
      `- Judge's reasoning: ${oneLine(cause.reasoning, 600)}`,
    );
  }
  const earlier = [...input.previous].filter((record) => record.state !== 'running')
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)).slice(0, 5);
  lines.push('', '## Previous improvements');
  if (!earlier.length) lines.push('', 'None yet.');
  for (const record of earlier) {
    const pr = record.pr?.url ?? (record.pr?.number ? `#${record.pr.number}` : 'no PR');
    const fixed = (record.clusters ?? []).filter((cluster) => cluster.decision === 'fixed').map((cluster) => cluster.id);
    lines.push('', `- ${record.id}: ${record.state}, ${pr}${record.mergedAt ? `, merged ${record.mergedAt.slice(0, 10)}` : ''}; fixed: ${fixed.join(', ') || 'none'}`);
  }
  return lines.join('\n');
}

function oneLine(text: string, max = 1000): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
