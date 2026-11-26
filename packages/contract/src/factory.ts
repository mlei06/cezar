import { z } from 'zod';

export const scorerNameSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
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
