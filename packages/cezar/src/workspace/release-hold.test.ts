import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { ReleaseHold } from './release-hold.ts';

it('recovers an admission hold after restart and expires it without its caller', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-release-hold-'));
  vi.stubEnv('CEZ_HOME', root);
  vi.useFakeTimers();
  try {
    const first = new ReleaseHold(vi.fn());
    const lease = first.acquire(60);
    expect(lease).toBeDefined();
    expect(first.acquire(60)).toBeUndefined();
    const wake = vi.fn();
    const restarted = new ReleaseHold(wake);
    expect(restarted.current()).toEqual(lease);
    expect(restarted.release('invalid')).toBe(false);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(wake).toHaveBeenCalledOnce();
    expect(restarted.current()).toBeUndefined();
    expect(new ReleaseHold(vi.fn()).current()).toBeUndefined();
  } finally {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
