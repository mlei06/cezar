import { z } from 'zod';
import { runnerSchema } from './runners.ts';
import { harnessVersionSchema } from './runs.ts';

export const scorerNameSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
export const factoryScoringSettingsSchema = z.object({
  enabled: z.boolean().optional().catch(undefined),
  sampling: z.record(scorerNameSchema, z.number().min(0).max(100)).optional().catch(undefined),
}).passthrough();
const scorerLabelSchema = z.object({
  value: scorerNameSchema,
  score: z.number().min(0).max(1),
  description: z.string().trim().min(1),
});
export const scorerMetadataSchema = z.object({
  description: z.string().trim().min(1),
  workflows: z.array(z.string().min(1)).optional(),
  labels: z.array(scorerLabelSchema).min(2),
  passingScore: z.number().min(0).max(1),
  samplingRate: z.number().min(0).max(100).default(100),
}).strict().superRefine((scorer, ctx) => {
  const labels = new Set(scorer.labels.map((label) => label.value));
  if (labels.size !== scorer.labels.length) {
    ctx.addIssue({ code: 'custom', path: ['labels'], message: 'Scorer label values must be distinct.' });
  }
  if (!scorer.labels.some((label) => label.score >= scorer.passingScore)
    || !scorer.labels.some((label) => label.score < scorer.passingScore)) {
    ctx.addIssue({ code: 'custom', path: ['labels'], message: 'A scorer needs at least one passing and one failing label.' });
  }
});
export type ScorerMetadata = z.infer<typeof scorerMetadataSchema>;

export const scoreCauseSchema = z.object({
  category: z.enum(['harness', 'task-setup', 'repository', 'access', 'model', 'requirements', 'external']),
  target: z.enum(['harness', 'manager-skill', 'workflow', 'skill', 'agents-md', 'docs', 'code', 'brief', 'infra']),
  evidence: z.string().trim().min(1).max(2000),
  fix: z.string().trim().min(1).max(2000),
}).strict();
export type ScoreCause = z.infer<typeof scoreCauseSchema>;

export const recordedScoreSchema = z.object({
  scorer: scorerNameSchema,
  label: scorerNameSchema,
  score: z.number().min(0).max(1),
  pass: z.boolean(),
  reasoning: z.string(),
  evidence: z.array(z.string()),
  causes: z.array(scoreCauseSchema).max(3),
  judge: z.object({
    runner: runnerSchema,
    model: z.string().optional(),
    transcriptChars: z.number().int().nonnegative(),
    shortened: z.boolean(),
  }),
  harnessVersion: harnessVersionSchema.optional(),
  projectCommit: z.string().optional(),
  at: z.string().datetime(),
});
export type RecordedScore = z.infer<typeof recordedScoreSchema>;

export const taskScoreEntrySchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending'), finishedAt: z.string().datetime(), retryAt: z.string().datetime(), outages: z.number().int().nonnegative() }),
  z.object({ status: z.literal('error'), finishedAt: z.string().datetime(), reason: z.string() }),
  z.object({ status: z.literal('scored'), finishedAt: z.string().datetime(), score: recordedScoreSchema }),
]);
export type TaskScoreEntry = z.infer<typeof taskScoreEntrySchema>;

export const runScoresResponseSchema = z.object({ scores: z.record(scorerNameSchema, taskScoreEntrySchema) });
export type RunScoresResponse = z.infer<typeof runScoresResponseSchema>;
export const scoreRunInputSchema = z.object({ scorer: scorerNameSchema.optional() }).strict();
export const scoreRunResponseSchema = z.object({ queued: z.array(scorerNameSchema) });
export type ScoreRunResponse = z.infer<typeof scoreRunResponseSchema>;
export const scoreRecordedEventSchema = z.object({
  projectId: z.string(),
  runId: z.string(),
  score: recordedScoreSchema,
});
export type ScoreRecordedEvent = z.infer<typeof scoreRecordedEventSchema>;

export const queuedCauseSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  runId: z.string(),
  scorer: scorerNameSchema,
  label: scorerNameSchema,
  reasoning: z.string(),
  cause: scoreCauseSchema,
  at: z.string().datetime(),
  state: z.enum(['open', 'processing', 'processed', 'dismissed', 'escalated', 'deferred']),
});
export type QueuedCause = z.infer<typeof queuedCauseSchema>;
export const causeQueueSchema = z.array(queuedCauseSchema);

export const scoresQuerySchema = z.object({
  since: z.string().datetime().or(z.string().date()).optional(),
  groupBy: z.enum(['scorer', 'category', 'target']).default('scorer'),
});
export type ScoresQuery = z.infer<typeof scoresQuerySchema>;

const scoreGroupSchema = z.object({
  key: z.string(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
});
export type ScoreGroup = z.infer<typeof scoreGroupSchema>;
export const scoresResponseSchema = z.object({ groups: z.array(scoreGroupSchema) });
export type ScoresResponse = z.infer<typeof scoresResponseSchema>;
export const workspaceScoresResponseSchema = z.object({
  projects: z.array(scoresResponseSchema.extend({ projectId: z.string() })),
});
export type WorkspaceScoresResponse = z.infer<typeof workspaceScoresResponseSchema>;
export const managerScoresQuerySchema = scoresQuerySchema.extend({ projectId: z.string().min(1).max(200) });
export type ManagerScoresQuery = z.infer<typeof managerScoresQuerySchema>;
export const factoryCheckResponseSchema = z.object({
  issues: z.array(z.object({ path: z.string(), message: z.string() })),
});
export type FactoryCheckResponse = z.infer<typeof factoryCheckResponseSchema>;
