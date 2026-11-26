import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { releaseHoldLeaseSchema, type ReleaseHoldLease } from '@open-mercato/cezar-contract';
import { cezarHomeDir } from '../paths.ts';
import { atomicWriteJsonSync } from './config.ts';

/** Survives a release restart and expires if the release process dies. */
export class ReleaseHold {
  private lease?: ReleaseHoldLease;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly path = join(cezarHomeDir(), 'factory', 'release-hold.json');

  constructor(private readonly onEnded: () => void) {
    const recorded = this.read();
    if (recorded && Date.parse(recorded.expiresAt) > Date.now()) this.set(recorded);
  }

  current(): ReleaseHoldLease | undefined {
    return this.lease && Date.parse(this.lease.expiresAt) > Date.now() ? this.lease : undefined;
  }

  acquire(seconds: number): ReleaseHoldLease | undefined {
    const recorded = this.read();
    if (this.current() || recorded && Date.parse(recorded.expiresAt) > Date.now()) return undefined;
    const lease = { id: randomUUID(), expiresAt: new Date(Date.now() + seconds * 1000).toISOString() };
    atomicWriteJsonSync(this.path, lease);
    this.set(lease);
    return lease;
  }

  release(id: string): boolean {
    if (this.lease?.id !== id) return false;
    if (this.read()?.id === id) rmSync(this.path, { force: true });
    this.lease = undefined;
    clearTimeout(this.timer);
    this.onEnded();
    return true;
  }

  private read(): ReleaseHoldLease | undefined {
    try {
      const current = releaseHoldLeaseSchema.safeParse(JSON.parse(readFileSync(this.path, 'utf8')));
      return current.success ? current.data : undefined;
    } catch {
      return undefined;
    }
  }

  private set(lease: ReleaseHoldLease): void {
    this.lease = lease;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      try { this.release(lease.id); } catch {
        // The expired file is inert even if the workspace became read-only.
        this.lease = undefined;
        this.onEnded();
      }
    }, Math.max(0, Date.parse(lease.expiresAt) - Date.now()));
    this.timer.unref?.();
  }
}
