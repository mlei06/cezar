import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { RecordedScore, RunScoreSummary, ScoreChangedEvent, ScoreRecordedEvent, TaskScoreEntry } from '@open-mercato/cezar-contract';
import { loadConfig } from '../config.ts';
import { ScorerCatalog } from '../factory/scorers.ts';
import type { RunRecord, RunStore } from '../runs/store.ts';
import { summarizeRunMetrics } from '../runs/task-metrics.ts';
import { loadWorkflows } from '../workflows/load.ts';
import { loadWorkspaceConfig } from '../workspace/config.ts';
import { SecretStore } from '../workspace/secrets.ts';
import { evaluateScorer } from './evaluate.ts';
import { JudgeQueue } from './queue.ts';
import { resolveJudgeRoute, type JudgeRoute } from './runner.ts';
import { referencedSpecContext } from './spec-context.ts';
import { readRunScores, writeRunScore } from './store.ts';
import { renderJudgeTranscript } from './transcript.ts';

export interface ScoringProject {
  id: string;
  root: string;
  dataDir: string;
  store: RunStore;
}

export interface SettledScore {
  run: RunRecord;
  score: RecordedScore;
}

function scoringEnabled(): boolean {
  return process.env.CEZ_SCORING !== '0' && process.env.CEZ_DRY_RUN !== '1';
}

function settledAt(run: RunRecord): string | undefined {
  return run.startedAt && ['done', 'review', 'failed', 'cancelled'].includes(run.status) ? run.finishedAt : undefined;
}

function sampled(runId: string, scorer: string, percent: number): boolean {
  const hash = createHash('sha256').update(runId).update('\0').update(scorer).digest().readUInt32BE(0);
  return hash / 2 ** 32 * 100 < percent;
}

function summarizeScores(scores: Record<string, TaskScoreEntry>, finishedAt: string): RunScoreSummary {
  const ordered = [...new Set(['outcome', 'efficiency', 'procedure', 'scope', ...Object.keys(scores)])];
  const scored = (name: string) => {
    const entry = scores[name];
    return entry?.status === 'scored' && entry.finishedAt === finishedAt ? entry.score : undefined;
  };
  const outcome = scored('outcome');
  const efficiency = scored('efficiency');
  const mainCause = ordered.map((name) => scored(name)?.causes[0]?.target).find((cause) => cause !== undefined);
  return {
    finishedAt,
    ...(outcome ? { outcome: { label: outcome.label, pass: outcome.pass } } : {}),
    ...(efficiency ? { efficiency: { label: efficiency.label, pass: efficiency.pass } } : {}),
    ...(mainCause ? { mainCause } : {}),
  };
}

export class ScoringService {
  private readonly catalog = new ScorerCatalog(true);
  private readonly queue = new JudgeQueue();

  constructor(private readonly onScore: (event: ScoreRecordedEvent, project: ScoringProject, run: RunRecord) => void,
    private readonly judgeFor: (repoRoot: string) => Promise<JudgeRoute | { error: string }> = resolveJudgeRoute,
    private readonly secrets = new SecretStore(),
    private readonly reconcileScores?: (project: ScoringProject, scores: readonly SettledScore[]) => void,
    private readonly onChanged?: (event: ScoreChangedEvent) => void) {}

  watch(project: ScoringProject, recoveredSince?: number): () => void {
    if (!scoringEnabled()) return () => undefined;
    const runs = project.store.listRuns();
    const observed = new Map(runs.map((run) => [run.id, settledAt(run)]));
    const loadPending = () => {
      const saved: SettledScore[] = [];
      for (const run of runs) {
        try {
          const at = settledAt(run);
          if (!at) continue;
          const scores = Object.values(readRunScores(project.dataDir, run.id)).filter((entry) => entry.finishedAt === at);
          if (this.reconcileScores) {
            for (const entry of scores) {
              if (entry.status === 'scored') saved.push({ run, score: entry.score });
            }
          }
          if (scores.some((entry) => entry.status === 'pending')) {
            void this.queueRun(project, run, 'resume').catch(() => undefined);
          } else if (recoveredSince !== undefined && Date.parse(at) >= recoveredSince) {
            // Recovery can settle a task before the server attaches its watcher.
            void this.queueRun(project, run, 'new').catch(() => undefined);
          }
        } catch {
          // A damaged score file does not prevent opening the project or other tasks.
        }
      }
      if (saved.length) this.reconcileScores?.(project, saved);
    };
    const initial = setImmediate(loadPending);
    const changed = (run: RunRecord) => {
      const at = settledAt(run);
      if (observed.get(run.id) === at) return;
      observed.set(run.id, at);
      if (at) void this.queueRun(project, run, 'new').catch(() => undefined);
    };
    const deleted = (id: string) => observed.delete(id);
    project.store.on('run', changed);
    project.store.on('deleted', deleted);
    return () => {
      clearImmediate(initial);
      project.store.off('run', changed);
      project.store.off('deleted', deleted);
    };
  }

  dispose(): void {
    this.queue.dispose();
  }

  async rescore(project: ScoringProject, run: RunRecord, selected?: string): Promise<{ queued: string[] }> {
    return { queued: await this.queueRun(project, run, 'manual', selected) };
  }

  private async queueRun(project: ScoringProject, run: RunRecord, kind: 'new' | 'resume' | 'manual', selected?: string): Promise<string[]> {
    const finishedAt = settledAt(run);
    if (!finishedAt || !scoringEnabled()) return [];
    const redactRun = project.store.captureRunRedaction(run.id);
    const [local, workspace, { workflows }] = await Promise.all([
      loadConfig(project.root), loadWorkspaceConfig(), loadWorkflows(project.root),
    ]);
    const localSettings = local.factory?.scoring;
    const globalSettings = workspace.factory?.scoring;
    if (!(localSettings?.enabled ?? globalSettings?.enabled ?? true)) return [];
    const { scorers } = await this.catalog.load(project.root, new Set(workflows.map(({ name }) => name)));
    if (project.store.getRun(run.id) !== run || settledAt(run) !== finishedAt) return [];
    const existing = readRunScores(project.dataDir, run.id);
    const now = Date.now();
    const queued: string[] = [];
    let snapshot: { events: ReturnType<RunStore['readEvents']>; metrics: ReturnType<typeof summarizeRunMetrics> } | undefined;
    const transcriptInput = () => {
      if (!snapshot) {
        const events = project.store.readEvents(run.id);
        snapshot = { events, metrics: summarizeRunMetrics(run, events) };
      }
      return snapshot;
    };
    for (const scorer of scorers) {
      if (selected ? scorer.name !== selected : scorer.workflows && !scorer.workflows.includes(run.workflow)) continue;
      if (run.status === 'cancelled' && scorer.name === 'outcome') continue;
      const current = existing[scorer.name];
      const pending = current?.finishedAt === finishedAt && current.status === 'pending' ? current : undefined;
      if (kind === 'resume' && !pending) continue;
      if (kind === 'new') {
        if (current?.finishedAt === finishedAt && !pending) continue;
        const percent = localSettings?.sampling?.[scorer.name] ?? globalSettings?.sampling?.[scorer.name] ?? scorer.samplingRate;
        if (!pending && !sampled(run.id, scorer.name, percent)) continue;
      }
      const retryAt = kind !== 'manual' && pending ? Date.parse(pending.retryAt) : now;
      const outages = kind !== 'manual' ? pending?.outages ?? 0 : 0;
      let route: JudgeRoute | undefined;
      const stillCurrent = () => project.store.getRun(run.id) === run && settledAt(run) === finishedAt;
      const save = (value: TaskScoreEntry) => {
        if (!stillCurrent()) return;
        writeRunScore(project.dataDir, run.id, scorer.name, value);
        if (value.status === 'scored' || run.scoreSummary) {
          const scoreSummary = summarizeScores(readRunScores(project.dataDir, run.id), finishedAt);
          if (!isDeepStrictEqual(scoreSummary, run.scoreSummary)) project.store.updateRun(run.id, { scoreSummary });
        }
        if (value.status !== 'scored') this.onChanged?.({ projectId: project.id, runId: run.id });
      };
      const accepted = this.queue.enqueue({
        id: JSON.stringify([project.id, run.id, finishedAt, scorer.name]),
        finishedAt: Date.parse(finishedAt),
        retryAt,
        outages,
        core: scorer.name === 'outcome' || scorer.name === 'efficiency',
        evaluate: async () => {
          if (!stillCurrent()) return { status: 'error', reason: 'The task changed before it could be scored.' };
          if (!scoringEnabled()) return { status: 'error', reason: 'Scoring is disabled.' };
          const chosen = await this.judgeFor(project.root);
          if ('error' in chosen) return { status: 'error', reason: chosen.error };
          route = chosen;
          const [workspaceVault, projectVault, spec] = await Promise.all([
            this.secrets.read({ kind: 'workspace' }),
            this.secrets.read({ kind: 'project', projectId: project.id, root: project.root }),
            scorer.name === 'scope' ? referencedSpecContext(project.root, run) : undefined,
          ]);
          if (workspaceVault.skipped || projectVault.skipped) {
            return { status: 'error', reason: 'Scoring could not read the secret store for transcript redaction.' };
          }
          const credentials = [workspaceVault, projectVault].flatMap(vault => Object.values(vault.values).map(entry => entry.value));
          const redact = <T>(value: T) => redactRun(value, credentials);
          // Scrub structured text before serialization and output shortening.
          const { metrics, events } = redact(transcriptInput());
          const safeRun = { ...run, ...redact({
            title: run.title, titleSummary: run.titleSummary, task: run.task, workflow: run.workflow, pullRequestUrl: run.pullRequestUrl,
          }) };
          const safeSpec = spec ? redact(spec) : undefined;
          const evaluation = await evaluateScorer(scorer,
            (maxChars) => renderJudgeTranscript(safeRun, metrics, events, maxChars, safeSpec),
            (input) => chosen.call({ ...input, systemPrompt: redact(input.systemPrompt) }));
          return evaluation.status === 'scored' ? { ...evaluation, verdict: redact(evaluation.verdict) } : evaluation;
        },
        update: (result) => {
          if (!stillCurrent()) return;
          switch (result.status) {
            case 'pending':
              save({ ...result, finishedAt, retryAt: new Date(result.retryAt).toISOString() });
              break;
            case 'error':
              save({ ...result, finishedAt });
              break;
            case 'scored':
              if (!route) break;
              const score: RecordedScore = {
                scorer: scorer.name, ...result.verdict,
                judge: { runner: route.runner, ...(route.model ? { model: route.model } : {}),
                  transcriptChars: result.transcriptChars, shortened: result.shortened },
                ...(run.harnessVersion ? { harnessVersion: run.harnessVersion } : {}),
                ...(run.startCommit ? { projectCommit: run.startCommit } : {}),
                at: new Date().toISOString(),
              };
              save({ status: 'scored', finishedAt, score });
              this.onScore({ projectId: project.id, runId: run.id, score }, project, run);
              break;
          }
        },
      });
      if (accepted) {
        save({ status: 'pending', finishedAt, retryAt: new Date(retryAt).toISOString(), outages });
        queued.push(scorer.name);
      }
    }
    return queued;
  }
}
