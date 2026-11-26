import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ImprovementRecord } from '@open-mercato/cezar-contract';
import { harnessCauseQueuePath, projectCauseQueuePath, readCauseQueue } from '../factory/causes.ts';
import { artifactsDir, type RunRecord } from '../runs/store.ts';
import { readRunScores } from '../scoring/store.ts';
import { prNumberOfUrl } from '../server/forge/pr-url.ts';
import { IMPROVE_FACTORY_DECISIONS_FILE } from '../workflows/templates.ts';
import {
  closeImprovement, failImprovement, finishImprovement, harnessImprovementRecordsPath, mergeImprovement,
  projectImprovementRecordsPath, readImprovementDecisions, readImprovementRecords, startImprovement, type ImprovementPaths,
} from './bookkeeping.ts';
import { buildImprovementBrief } from './brief.ts';
import type { ImprovementSettings } from './settings.ts';
import { evaluateImprovementTrigger } from './trigger.ts';

/** What the service needs of a project; the server supplies the run store and launcher. */
export interface ImprovementProject {
  id: string;
  root: string;
  dataDir: string;
  listRuns: () => RunRecord[];
  getRun: (id: string) => RunRecord | undefined;
  onRun: (listener: (run: RunRecord) => void) => () => void;
  /** Start the `improve-factory` run with this brief; an error explains why it couldn't. */
  startRun: (task: string) => Promise<{ id: string } | { error: string }>;
}

export interface ImprovementServiceDeps {
  /** Whether this project consumes the harness queue (spec D6 `factory.harnessProject`). */
  isHarness: (project: ImprovementProject) => Promise<boolean>;
  settings: (project: ImprovementProject, harness: boolean) => Promise<ImprovementSettings>;
  /** The improvement PR's state on the forge, when known. */
  prState?: (project: ImprovementProject, number: number) => Promise<'open' | 'merged' | 'closed' | undefined>;
  now?: () => Date;
}

export type ImprovementStart =
  | { started: true; improvementId: string; runId: string; causes: number }
  | { started: false; reason: string };

const SETTLED = new Set(['done', 'review', 'failed', 'cancelled']);

/** Self-improvement for one cockpit (spec D6): starts runs from a queue and keeps their bookkeeping. */
export class ImprovementService {
  constructor(private readonly deps: ImprovementServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  async paths(project: ImprovementProject): Promise<ImprovementPaths & { harness: boolean }> {
    const harness = await this.deps.isHarness(project);
    return harness
      ? { harness, queue: harnessCauseQueuePath(), records: harnessImprovementRecordsPath() }
      : { harness, queue: projectCauseQueuePath(project.dataDir), records: projectImprovementRecordsPath(project.dataDir), harnessQueue: harnessCauseQueuePath() };
  }

  /** Start an improvement run now if the queue and guards allow it (spec D6). */
  async start(project: ImprovementProject, input: { startedBy: ImprovementRecord['startedBy']; manual: boolean }): Promise<ImprovementStart> {
    const paths = await this.paths(project);
    await this.refreshPullRequests(project, paths);
    const settings = await this.deps.settings(project, paths.harness);
    const records = readImprovementRecords(paths.records);
    const now = this.now();
    const decision = evaluateImprovementTrigger({
      queue: readCauseQueue(paths.queue), records, settings, now, manual: input.manual,
      scoredRunsSinceMerge: this.scoredRunsSinceMerge(project, records),
    });
    if (!decision.fire) return { started: false, reason: decision.reason };
    const brief = buildImprovementBrief({
      projectId: project.id, queue: paths.harness ? 'harness' : 'project', batch: decision.batch, previous: records, settings, now,
    });
    const run = await project.startRun(brief);
    if ('error' in run) return { started: false, reason: run.error };
    const record = startImprovement(paths, {
      id: randomUUID(), projectId: project.id, runId: run.id, startedBy: input.startedBy, startedAt: now.toISOString(), batch: decision.batch,
    });
    return { started: true, improvementId: record.id, runId: run.id, causes: record.causeIds.length };
  }

  /** Settle a finished improvement run's bookkeeping; returns the record it changed, if any. */
  async settle(project: ImprovementProject, run: RunRecord): Promise<ImprovementRecord | undefined> {
    if (!SETTLED.has(run.status)) return undefined;
    const paths = await this.paths(project);
    const record = readImprovementRecords(paths.records).find((entry) => entry.runId === run.id && entry.state === 'running');
    if (!record) return undefined;
    if (run.status === 'failed' || run.status === 'cancelled') return failImprovement(paths, record.id, this.now());
    const read = readImprovementDecisions(join(artifactsDir(project.dataDir, run.id), IMPROVE_FACTORY_DECISIONS_FILE));
    if ('error' in read) return failImprovement(paths, record.id, this.now());
    const number = prNumberOfUrl(run.pullRequestUrl);
    const pr = run.pullRequestUrl ? { url: run.pullRequestUrl, ...(number ? { number } : {}) } : undefined;
    return finishImprovement(paths, record.id, { decisions: read.decisions, ...(pr ? { pr } : {}), now: this.now() });
  }

  /** Settle improvement runs as they finish, including any that finished while the cockpit was down. */
  watch(project: ImprovementProject): () => void {
    const settle = (run: RunRecord) => { void this.settle(project, run).catch(() => undefined); };
    const initial = setImmediate(() => {
      void this.paths(project).then((paths) => {
        for (const record of readImprovementRecords(paths.records)) {
          const run = record.state === 'running' && record.runId ? project.getRun(record.runId) : undefined;
          if (run) settle(run);
        }
      }).catch(() => undefined);
    });
    const off = project.onRun(settle);
    return () => { clearImmediate(initial); off(); };
  }

  /** Close the loop on open improvement PRs from the forge's view (spec D6 "After a merge"). */
  async refreshPullRequests(project: ImprovementProject, paths: ImprovementPaths): Promise<void> {
    if (!this.deps.prState) return;
    for (const record of readImprovementRecords(paths.records)) {
      if (record.state !== 'pr-open' || !record.pr?.number) continue;
      const state = await this.deps.prState(project, record.pr.number).catch(() => undefined);
      if (state === 'merged') mergeImprovement(paths, record.id, { at: this.now() });
      else if (state === 'closed') closeImprovement(paths, record.id, this.now());
    }
  }

  private scoredRunsSinceMerge(project: ImprovementProject, records: readonly ImprovementRecord[]): number {
    const lastMerge = records.map((record) => record.mergedAt).filter((at): at is string => Boolean(at)).sort().at(-1);
    if (!lastMerge) return 0;
    return project.listRuns().filter((run) => run.finishedAt && run.finishedAt > lastMerge &&
      Object.values(readRunScores(project.dataDir, run.id)).some((entry) => entry.status === 'scored')).length;
  }
}
