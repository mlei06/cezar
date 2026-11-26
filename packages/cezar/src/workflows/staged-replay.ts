import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  replayRunResponseSchema, runRecordSchema, type HarnessVersion,
} from '@open-mercato/cezar-contract';
import { readRunEvents, RunStore, type RunRecord } from '../runs/store.ts';
import { findInstalled, listInstalled, versionDir, versionEntry } from '../self-update/layout.ts';
import { withStagingCockpit } from '../self-update/staging.ts';
import { getHeadCommit } from '../server/git.ts';

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const exec = promisify(execFile);

interface ReplayHarness extends HarnessVersion { commit: string; entry: string }

export async function resolveReplayHarness(request: string): Promise<ReplayHarness | { error: string }> {
  const installed = findInstalled(request);
  if (!installed) {
    const ids = listInstalled().map(({ id }) => id);
    return { error: 'The requested harness version is unavailable.' + (ids.length ? ' Installed versions: ' + ids.join(', ') : '') };
  }
  const entry = versionEntry(installed.id);
  const dist = dirname(entry);
  if (!existsSync(join(dist, 'workflows', 'replay-cli.js'))) {
    return { error: 'The installed version predates isolated replay support.' };
  }
  let commit: unknown;
  try {
    const metadata = JSON.parse(await readFile(join(dist, '..', 'package.json'), 'utf8')) as { gitHead?: unknown };
    commit = metadata.gitHead ?? (installed.checkout ? await getHeadCommit(installed.checkout) : undefined);
  } catch { /* The refusal below also covers old package metadata. */ }
  if (typeof commit !== 'string' || !SHA.test(commit)) return { error: 'The installed harness has no exact commit identity.' };
  return { id: installed.id, commit, entry };
}

async function seedProject(repoRoot: string, source: RunRecord, target: ReplayHarness, project: string, workspace: string, signal: AbortSignal) {
  const commit = source.startCommit;
  if (!commit || !SHA.test(commit) || !source.workflowDef) throw new Error('Replay is missing exact input.');
  const git = (args: string[]) => exec('git', args, {
    cwd: project, signal, timeout: 90_000, env: {
      PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0',
    },
  });
  await git(['init', '-q', '-b', 'replay-base']);
  await git(['-c', 'protocol.file.allow=always', 'fetch', '--quiet', '--no-tags', '--no-recurse-submodules',
    pathToFileURL(repoRoot).href, commit]);
  await git(['update-ref', 'refs/heads/replay-base', commit]);
  const versions = join(workspace, 'versions');
  await mkdir(versions, { recursive: true });
  await symlink(versionDir(target.id), join(versions, target.id), 'dir');
  const dataDir = join(project, '.ai/cezar');
  const store = RunStore.open(dataDir);
  const baseline = store.createRun({ title: source.title, task: source.task, workflow: source.workflow, steps: [] });
  const at = new Date().toISOString();
  store.updateRun(baseline.id, {
    status: 'done', startedAt: at, finishedAt: at, startCommit: commit, baseBranch: commit,
    harnessVersion: { id: target.id, commit: target.commit }, workflowDef: source.workflowDef,
    systemPrompt: source.systemPrompt,
  });
  store.flush();
  return { id: baseline.id, dataDir, entry: versionEntry(target.id, { CEZ_HOME: workspace }) };
}

/** A staged check replay uses the candidate's normal replay API. No user configuration,
 * service credentials or model sessions are copied into the scratch cockpit. */
export async function stagedCheckReplay(repoRoot: string, source: RunRecord, signal: AbortSignal) {
  const version = source.harnessVersion;
  if (!version?.commit) throw new Error('Replay has no pinned harness version.');
  const target = await resolveReplayHarness(version.id);
  if ('error' in target) throw new Error(target.error);
  if (target.commit !== version.commit) throw new Error('The installed harness changed after replay admission.');
  let seed: Awaited<ReturnType<typeof seedProject>> | undefined;
  return withStagingCockpit(target.entry, async (api) => {
    if (!seed) throw new Error('The staging replay did not create its baseline.');
    const request = async (path: string, body?: object) => {
      const response = await fetch(api + path, {
        redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
        ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) throw new Error(`The staged replay returned HTTP ${response.status}.`);
      return response.json() as Promise<unknown>;
    };
    const admitted = replayRunResponseSchema.parse(await request('/runs/' + seed.id + '/replay', { times: 1 }));
    const id = admitted.runs[0]!;
    const end = Date.now() + 30 * 60_000;
    while (Date.now() < end) {
      const run = runRecordSchema.parse(await request('/runs/' + id));
      if (run.status === 'done' || run.status === 'review' || run.status === 'failed' || run.status === 'cancelled') {
        if (run.harnessVersion?.id !== target.id || run.harnessVersion.commit !== target.commit ||
          run.startCommit !== source.startCommit) throw new Error('Staging replay did not preserve the pinned versions.');
        return { run, events: readRunEvents(join(seed.dataDir, 'runs', id + '.ndjson')) };
      }
      await wait(250, undefined, { signal });
    }
    throw new Error('The staged replay did not finish within 30 minutes.');
  }, {
    signal,
    prepare: async (project, workspace) => {
      seed = await seedProject(repoRoot, source, target, project, workspace, signal);
      return seed.entry;
    },
  });
}
