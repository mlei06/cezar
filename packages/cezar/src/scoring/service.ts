import { createHash } from 'node:crypto';
import type { RecordedScore, ScoreRecordedEvent, TaskScoreEntry } from '@open-mercato/cezar-contract';
import { loadConfig } from '../config.ts';
import { ScorerCatalog } from '../factory/scorers.ts';
import type { RunRecord, RunStore } from '../runs/store.ts';
import { summarizeRunMetrics } from '../runs/task-metrics.ts';
import { loadWorkflows } from '../workflows/load.ts';
import { loadWorkspaceConfig } from '../workspace/config.ts';
import { evaluateScorer } from './evaluate.ts';
import { JudgeQueue } from './queue.ts';
import { resolveJudgeRoute, type JudgeRoute } from './runner.ts';
import { readRunScores, writeRunScore } from './store.ts';
import { renderJudgeTranscript, type JudgeTranscript } from './transcript.ts';

export interface ScoringProject {
  id: string;
  root: string;
  dataDir: string;
  store: RunStore;
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

export class ScoringService {
  private readonly catalog = new ScorerCatalog();
  private readonly queue = new JudgeQueue();

  constructor(private readonly onScore: (event: ScoreRecordedEvent) => void,
    private readonly judgeFor: (repoRoot: string) => Promise<JudgeRoute | { error: string }> = resolveJudgeRoute) {}

  watch(project: ScoringProject): () => void {
    if (!scoringEnabled()) return () => undefined;
    const runs = project.store.listRuns();
    const observed = new Map(runs.map((run) => [run.id, settledAt(run)]));
    const loadPending = () => {
      for (const run of runs) {
        try {
          if (Object.values(readRunScores(project.dataDir, run.id)).some((score) => score.status === 'pending')) {
            void this.queueRun(project, run, 'resume').catch(() => undefined);
          }
        } catch {
          // A damaged score file does not prevent opening the project or other tasks.
        }
      }
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
    let transcript: JudgeTranscript | undefined;
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
        if (stillCurrent()) writeRunScore(project.dataDir, run.id, scorer.name, value);
      };
      const accepted = this.queue.enqueue({
        id: JSON.stringify([project.id, run.id, finishedAt, scorer.name]),
        finishedAt: Date.parse(finishedAt),
        retryAt,
        outages,
        evaluate: async () => {
          if (!stillCurrent()) return { status: 'error', reason: 'The task changed before it could be scored.' };
          if (!scoringEnabled()) return { status: 'error', reason: 'Scoring is disabled.' };
          const chosen = await this.judgeFor(project.root);
          if ('error' in chosen) return { status: 'error', reason: chosen.error };
          route = chosen;
          if (!transcript) {
            const events = project.store.readEvents(run.id);
            transcript = renderJudgeTranscript(run, summarizeRunMetrics(run, events), events, 300_000);
          }
          return evaluateScorer(scorer, transcript, route.call);
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
              this.onScore({ projectId: project.id, runId: run.id, score });
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
