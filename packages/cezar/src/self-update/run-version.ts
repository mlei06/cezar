import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { HarnessVersion } from '@open-mercato/cezar-contract';
import { getHeadCommit } from '../server/git.ts';
import { runsFromCheckout } from './layout.ts';
import { runningVersionId } from './versions-prune.ts';

const packageRoot = new URL('../../', import.meta.url);

async function identifyRunningHarness(): Promise<HarnessVersion> {
  let version = '0.0.0';
  let gitHead: string | undefined;
  try {
    const pkg = JSON.parse(readFileSync(new URL('package.json', packageRoot), 'utf8')) as {
      version?: string;
      gitHead?: string;
    };
    version = pkg.version ?? version;
    gitHead = pkg.gitHead;
  } catch {
    // A source or packaged entry should still run without readable version metadata.
  }
  const entry = process.argv[1] ?? fileURLToPath(new URL('dist/index.js', packageRoot));
  const id = runningVersionId(entry, process.env, fileURLToPath(import.meta.url)) ?? version;
  const checkout = fileURLToPath(new URL('src/index.ts', packageRoot));
  const commit = gitHead ?? (runsFromCheckout(checkout) ? await getHeadCommit(fileURLToPath(packageRoot)) : null);
  return { id, ...(commit ? { commit } : {}) };
}

// Read once per process. The active version symlink may move while this service is still running.
const runningHarness = identifyRunningHarness();

export function runHarnessVersion(): Promise<HarnessVersion> {
  return runningHarness;
}
