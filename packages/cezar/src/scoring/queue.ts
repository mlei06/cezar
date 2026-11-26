import { JUDGE_OUTAGE_RETRY_MS, type JudgeEvaluation } from './evaluate.ts';

type CompletedEvaluation = Exclude<JudgeEvaluation, { status: 'unavailable' }>;
type PendingEvaluation = { status: 'pending'; retryAt: number; outages: number };
export type QueueUpdate = CompletedEvaluation | PendingEvaluation;

export interface JudgeJob {
  id: string;
  finishedAt: number;
  retryAt: number;
  outages: number;
  evaluate(): Promise<JudgeEvaluation>;
  update(result: QueueUpdate): void;
}

/** One queue for the workspace. Newest ready jobs win, and an outage never holds the worker. */
export class JudgeQueue {
  private readonly waiting = new Map<string, JudgeJob>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private working: string | undefined;
  private disposed = false;

  constructor(private readonly now = Date.now) {}

  enqueue(job: JudgeJob): boolean {
    if (this.disposed || this.waiting.has(job.id) || this.working === job.id) return false;
    this.waiting.set(job.id, job);
    this.schedule();
    return true;
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.waiting.clear();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    if (this.disposed || this.working || !this.waiting.size) return;
    const earliest = Math.min(...[...this.waiting.values()].map((job) => job.retryAt));
    this.timer = setTimeout(() => void this.process(), Math.max(0, earliest - this.now()));
    this.timer.unref?.();
  }

  private async process(): Promise<void> {
    const now = this.now();
    const ready = [...this.waiting.values()]
      .filter((job) => job.retryAt <= now)
      .sort((a, b) => b.finishedAt - a.finishedAt);
    const job = ready[0];
    if (!job) { this.schedule(); return; }
    this.waiting.delete(job.id);
    this.working = job.id;
    try {
      const result = await job.evaluate().catch(() => ({ status: 'error', reason: 'The judge call failed.' } as const));
      if (this.disposed) return;
      if (result.status !== 'unavailable') {
        job.update(result);
        return;
      }
      const delay = JUDGE_OUTAGE_RETRY_MS[job.outages];
      if (delay === undefined) {
        job.update({ status: 'error', reason: 'The judge endpoint remained unavailable after three retries.' });
        return;
      }
      const retry = { status: 'pending', outages: job.outages + 1, retryAt: this.now() + delay } as const;
      job.update(retry);
      this.waiting.set(job.id, { ...job, ...retry });
    } catch {
      // A write failure leaves the earlier pending record on disk for the next reconciliation.
    } finally {
      this.working = undefined;
      this.schedule();
    }
  }
}
