import { z } from 'zod';
import { reasoningEffortSchema } from './agent.ts';
import { runnerSchema } from './runners.ts';
import { harnessVersionSchema } from './runs.ts';

export const replayRunInputSchema = z.object({
  harness: z.string().trim().min(1).max(190).optional(),
  workflow: z.string().trim().min(1).max(190).optional(),
  model: z.string().trim().min(1).max(190).optional(),
  runner: runnerSchema.optional(),
  effort: reasoningEffortSchema.optional(),
  skill: z.string().trim().min(1).max(190).optional(),
  brief: z.string().trim().min(1).max(100_000).optional(),
  times: z.number().int().min(1).max(5).default(1),
}).strict().refine(({ times: _times, ...changes }) =>
  Object.values(changes).filter((value) => value !== undefined).length <= 1, {
  message: 'Change at most one input per replay.',
});
export type ReplayRunInput = z.infer<typeof replayRunInputSchema>;

export const replayRunResponseSchema = z.object({
  groupId: z.string().uuid(),
  runs: z.array(z.string()).min(1).max(5),
});
export type ReplayRunResponse = z.infer<typeof replayRunResponseSchema>;

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
export const scoreChangedEventSchema = z.object({
  projectId: z.string(),
  runId: z.string(),
});
export type ScoreChangedEvent = z.infer<typeof scoreChangedEventSchema>;
export const scoreRecordedEventSchema = scoreChangedEventSchema.extend({
  score: recordedScoreSchema,
});
export type ScoreRecordedEvent = z.infer<typeof scoreRecordedEventSchema>;

const causeStateSchema = z.enum(['open', 'processing', 'processed', 'dismissed', 'escalated', 'deferred']);
export const queuedCauseSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  runId: z.string(),
  scorer: scorerNameSchema,
  label: scorerNameSchema,
  reasoning: z.string(),
  cause: scoreCauseSchema,
  at: z.string().datetime(),
  state: causeStateSchema,
});
export type QueuedCause = z.infer<typeof queuedCauseSchema>;
export const causeQueueSchema = z.array(queuedCauseSchema);
export const causeQueueResponseSchema = z.object({ causes: causeQueueSchema });
export type CauseQueueResponse = z.infer<typeof causeQueueResponseSchema>;
export const causeQueueCountsSchema = z.partialRecord(causeStateSchema, z.number().int().nonnegative());
export type CauseQueueCounts = z.infer<typeof causeQueueCountsSchema>;

export const scoresQuerySchema = z.object({
  since: z.union([z.string().datetime(), z.string().date(), z.string().regex(/^[1-9][0-9]{0,3}d$/)]).optional(),
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
export const scoresResponseSchema = z.object({
  groups: z.array(scoreGroupSchema),
  queue: z.object({ counts: causeQueueCountsSchema, openCauses: causeQueueSchema }).nullable(),
});
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

/** Self-improvement settings (spec D6, D7): global in workspace config, overridable per project. */
export const improvementApprovalSchema = z.enum(['manager', 'owner', 'none']);
export const improvementScopeSchema = z.enum(['docs', 'agents-md', 'skills', 'workflows', 'code']);
export type ImprovementScope = z.infer<typeof improvementScopeSchema>;
export const factoryImprovementSettingsSchema = z.object({
  enabled: z.boolean().optional().catch(undefined),
  threshold: z.number().int().min(1).max(100).optional().catch(undefined),
  ageDays: z.number().min(0).max(365).optional().catch(undefined),
  minForAge: z.number().int().min(1).max(100).optional().catch(undefined),
  cooldownRuns: z.number().int().min(0).max(1000).optional().catch(undefined),
  cooldownDays: z.number().min(0).max(365).optional().catch(undefined),
  approval: improvementApprovalSchema.optional().catch(undefined),
  scope: z.array(improvementScopeSchema).max(5).optional().catch(undefined),
}).passthrough();
export type FactoryImprovementSettings = z.infer<typeof factoryImprovementSettingsSchema>;

/** The decisions file an improvement run writes (the `improve-factory` skill defines it). */
export const improvementDecisionSchema = z.enum(['fixed', 'dismissed', 'escalated', 'deferred']);
export const improvementClusterSchema = z.object({
  id: z.string().trim().min(1).max(120),
  causes: z.array(z.string().min(1).max(64)).min(1).max(500),
  decision: improvementDecisionSchema,
  reason: z.string().trim().min(1).max(2000),
  files: z.array(z.string().min(1).max(500)).max(200).optional(),
  prevents: z.string().max(2000).optional(),
}).passthrough();
export type ImprovementCluster = z.infer<typeof improvementClusterSchema>;
export const improvementDecisionsSchema = z.object({
  clusters: z.array(improvementClusterSchema).max(200),
}).passthrough();
export type ImprovementDecisions = z.infer<typeof improvementDecisionsSchema>;

export const improvementRecordSchema = z.object({
  id: z.string().min(1).max(64),
  queue: z.enum(['project', 'harness']),
  projectId: z.string().min(1),
  runId: z.string().optional(),
  startedBy: z.enum(['manager', 'owner', 'automation']),
  startedAt: z.string().datetime(),
  causeIds: z.array(z.string()),
  state: z.enum(['running', 'pr-open', 'merged', 'closed', 'failed']),
  clusters: z.array(improvementClusterSchema).optional(),
  pr: z.object({ number: z.number().int().positive().optional(), url: z.string().optional() }).optional(),
  mergeCommit: z.string().optional(),
  mergedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
}).passthrough();
export type ImprovementRecord = z.infer<typeof improvementRecordSchema>;
export const improvementRecordsSchema = z.array(improvementRecordSchema);

/** `POST /factory/improve`: the owner's "Improve now" (spec D6); guards still apply. */
export const factoryImproveResponseSchema = z.discriminatedUnion('started', [
  z.object({ started: z.literal(true), improvementId: z.string(), runId: z.string(), causes: z.number().int().nonnegative() }),
  z.object({ started: z.literal(false), reason: z.string() }),
]);
export type FactoryImproveResponse = z.infer<typeof factoryImproveResponseSchema>;
