import { execFile } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { mkdir, open, readFile, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  changesPayloadSchema, MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENTS_TOTAL_BASE64, replayRunResponseSchema, runRecordSchema, type ChangesPayload, type HarnessVersion,
} from '@open-mercato/cezar-contract';
import { artifactsDir, readRunEvents, RunStore, type RunRecord } from '../runs/store.ts';
import { findInstalled, listInstalled, versionDir, versionEntry } from '../self-update/layout.ts';
import { withStagingCockpit } from '../self-update/staging.ts';
import { getHeadCommit } from '../server/git.ts';
import { atomicWriteJsonSync } from '../workspace/config.ts';
import { resolveProfileEnvForRoot } from '../workspace/agent-profiles.ts';

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

async function seedProject(
  repoRoot: string, sourceData: string, source: RunRecord, target: ReplayHarness, project: string, workspace: string, signal: AbortSignal,
) {
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
  const baseline = store.createRun({
    title: source.title, task: source.task, workflow: source.workflow, steps: [],
    runner: source.runner, model: source.model, reasoningEffort: source.reasoningEffort,
  });
  const images = await seedAttachments(sourceData, source, dataDir, baseline.id);
  const at = new Date().toISOString();
  store.updateRun(baseline.id, {
    status: 'done', startedAt: at, finishedAt: at, startCommit: commit, baseBranch: commit,
    harnessVersion: { id: target.id, commit: target.commit }, workflowDef: source.workflowDef,
    systemPrompt: source.systemPrompt, ...(images.length ? { taskImages: images } : {}),
  });
  store.flush();
  return { id: baseline.id, dataDir, entry: versionEntry(target.id, { CEZ_HOME: workspace }) };
}

async function seedAttachments(sourceData: string, source: RunRecord, dataDir: string, baselineId: string): Promise<string[]> {
  const urls = source.taskImages ?? [];
  if (!urls.length) return [];
  if (urls.length > MAX_ATTACHMENTS_PER_MESSAGE) throw new Error('Too many replay attachments.');
  const origin = join(sourceData, 'runs', source.id + '-images');
  const destination = join(dataDir, 'runs', baselineId + '-images');
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const images: string[] = [];
  let remaining = MAX_ATTACHMENTS_TOTAL_BASE64;
  for (const url of urls) {
    const name = url.split('/').pop();
    if (!name || name.includes('..') || name.includes('\\')) throw new Error('Invalid replay attachment name.');
    const file = await open(join(origin, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || Math.ceil(stat.size / 3) * 4 > remaining) throw new Error('Invalid replay attachment size.');
      const buffer = Buffer.alloc(stat.size);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead !== buffer.length) throw new Error('The replay attachment changed while copying.');
      await writeFile(join(destination, name), buffer, { mode: 0o600, flag: 'wx' });
      remaining -= Math.ceil(buffer.length / 3) * 4;
      images.push('/api/v1/runs/' + baselineId + '/images/' + name);
    } finally {
      await file.close();
    }
  }
  return images;
}

interface ReplayDiff {
  patch: string;
  changes: ChangesPayload;
}

const diffFile = (dataDir: string, id: string) => join(artifactsDir(dataDir, id), 'staged-replay-diff.json');

export function saveStagedReplayDiff(dataDir: string, id: string, diff: ReplayDiff): void {
  atomicWriteJsonSync(diffFile(dataDir, id), diff);
}

export async function readStagedReplayDiff(dataDir: string, id: string): Promise<ReplayDiff | undefined> {
  try {
    const file = await open(diffFile(dataDir, id), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 32_000_000) return undefined;
      const raw = JSON.parse(await file.readFile('utf8')) as { patch?: unknown; changes?: unknown };
      const changes = changesPayloadSchema.safeParse(raw.changes);
      if (typeof raw.patch === 'string' && changes.success) return { patch: raw.patch, changes: changes.data };
    } finally {
      await file.close();
    }
  } catch { /* Older and failed replays have no comparison snapshot. */ }
  return undefined;
}

/** The candidate uses its normal replay API. Only Codex's selected account home is
 * provided for real agent replays. Project config and service credentials stay out. */
export async function stagedReplay(repoRoot: string, sourceData: string, source: RunRecord, agent: boolean, signal: AbortSignal) {
  const dryRun = !agent || process.env.CEZ_DRY_RUN === '1';
  let codexHome: string | undefined;
  if (agent && !dryRun) {
    const { profile } = await resolveProfileEnvForRoot(repoRoot, 'codex', source.agentProfile);
    if (source.agentProfile && profile.id !== source.agentProfile) throw new Error('The original Codex account is unavailable.');
    codexHome = profile.path;
  }
  const version = source.harnessVersion;
  if (!version?.commit) throw new Error('Replay has no pinned harness version.');
  const target = await resolveReplayHarness(version.id);
  if ('error' in target) throw new Error(target.error);
  if (target.commit !== version.commit) throw new Error('The installed harness changed after replay admission.');
  let seed: Awaited<ReturnType<typeof seedProject>> | undefined;
  return withStagingCockpit(target.entry, async (api) => {
    if (!seed) throw new Error('The staging replay did not create its baseline.');
    const get = async (path: string, body?: object) => {
      const response = await fetch(api + path, {
        redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
        ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) throw new Error(`The staged replay returned HTTP ${response.status}.`);
      return response;
    };
    const admitted = replayRunResponseSchema.parse(await (await get('/runs/' + seed.id + '/replay', { times: 1 })).json());
    const id = admitted.runs[0]!;
    const end = Date.now() + 30 * 60_000;
    while (Date.now() < end) {
      const run = runRecordSchema.parse(await (await get('/runs/' + id)).json());
      if (run.status === 'done' || run.status === 'review' || run.status === 'failed' || run.status === 'cancelled') {
        if (run.harnessVersion?.id !== target.id || run.harnessVersion.commit !== target.commit ||
          run.startCommit !== source.startCommit) throw new Error('Staging replay did not preserve the pinned versions.');
        const events = readRunEvents(join(seed.dataDir, 'runs', id + '.ndjson'));
        if (!run.worktreePath) return { run, events };
        const [patch, changes] = await Promise.all([
          get('/runs/' + id + '/diff').then(response => response.text()),
          get('/runs/' + id + '/changes').then(response => response.json()).then(value => changesPayloadSchema.parse(value)),
        ]);
        return { run, events, diff: { patch, changes } };
      }
      await wait(250, undefined, { signal });
    }
    throw new Error('The staged replay did not finish within 30 minutes.');
  }, {
    signal, dryRun, codexHome,
    prepare: async (project, workspace) => {
      seed = await seedProject(repoRoot, sourceData, source, target, project, workspace, signal);
      return seed.entry;
    },
  });
}
