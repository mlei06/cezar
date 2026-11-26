import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { promisify } from 'node:util';
import { createRunResponseSchema, replayRunResponseSchema, runRecordSchema, runScoresResponseSchema, type RunRecord, type CreateRunInput } from '@open-mercato/cezar-contract';
import { stagingJson, withStagingCockpit } from '../self-update/staging.ts';
import { loadWorkspaceConfig } from '../workspace/config.ts';
import { readRunEvents } from '../runs/store.ts';

const exec = promisify(execFile);
export const HARNESS_SMOKE_SUITE = 'harness-smoke-v1';
const success = (run: RunRecord) => run.status === 'done' || run.status === 'review';

interface SmokeCase {
  name: string;
  input: Pick<CreateRunInput, 'steps' | 'runner' | 'variants' | 'autonomous'>;
  check: (runs: RunRecord[], projectCommit: string) => boolean;
}

const cases: SmokeCase[] = [
  {
    name: 'passing check',
    input: { steps: [{ id: 'verify', command: 'true' }] },
    check: ([run]) => run !== undefined && success(run),
  },
  {
    name: 'failed check',
    input: { steps: [{ id: 'verify', command: 'false' }] },
    check: ([run]) => run?.status === 'failed',
  },
  {
    name: 'runner turn',
    input: { runner: 'claude', autonomous: true, steps: [{ id: 'respond', prompt: 'mock:done' }] },
    check: ([run]) => run !== undefined && success(run) && run.steps.some((step) => Boolean(step.sessionId)),
  },
  {
    name: 'pinned project commit',
    input: { steps: [{ id: 'verify', command: 'true' }] },
    check: ([run], projectCommit) => run !== undefined && success(run) && run.startCommit === projectCommit && Boolean(run.harnessVersion),
  },
  {
    name: 'parallel variants',
    input: { variants: 2, steps: [{ id: 'verify', command: 'true' }] },
    check: (runs) => runs.length === 2 && runs.every(success) &&
      Boolean(runs[0]?.groupId) && runs[0]?.groupId === runs[1]?.groupId && runs[0]?.variant !== runs[1]?.variant,
  },
];

async function settle(api: string, initial: RunRecord[], finishWaiting = false): Promise<RunRecord[]> {
  const end = Date.now() + (finishWaiting ? 120_000 : 25_000);
  for (;;) {
    const runs = await Promise.all(initial.map(async ({ id }) =>
      runRecordSchema.parse(await stagingJson(api + '/runs/' + encodeURIComponent(id)))));
    if (runs.every((run) => success(run) || run.status === 'failed' || run.status === 'cancelled')) return runs;
    if (finishWaiting) {
      for (const run of runs) if (run.status === 'waiting') await stagingJson(api + '/runs/' + encodeURIComponent(run.id) + '/finish', {});
    }
    if (Date.now() >= end) throw new Error('The benchmark case did not settle.');
    await wait(250);
  }
}

export async function runHarnessSmokeSuite(entry: string) {
  let projectCommit = '';
  return withStagingCockpit(entry, async (api) => {
    const samples: Array<{ name: string; passed: boolean; milliseconds: number }> = [];
    for (const item of cases) {
      const start = Date.now();
      let passed = false;
      try {
        const created = createRunResponseSchema.parse(await stagingJson(api + '/runs', {
          task: 'Check the staged cockpit: ' + item.name, ...item.input,
        }));
        const runs = await settle(api, 'runs' in created ? created.runs : [created]);
        passed = item.check(runs, projectCommit);
      } catch {
        // A failed case counts against the candidate. The remaining cases still provide evidence.
      }
      samples.push({ name: item.name, passed, milliseconds: Date.now() - start });
    }
    return { passRate: samples.filter((item) => item.passed).length / samples.length * 100, samples };
  }, { prepare: async (project) => { projectCommit = await seedFixtureProject(project); } });
}

async function seedFixtureProject(project: string): Promise<string> {
  const git = (args: string[]) => exec('git', args, {
    cwd: project, timeout: 10_000,
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  await git(['init', '-q']);
  await writeFile(join(project, 'fixture.txt'), 'staging fixture marker\n', { mode: 0o600 });
  await git(['add', '--', 'fixture.txt']);
  await git([
    '-c', 'core.hooksPath=.no-hooks', '-c', 'commit.gpgSign=false',
    '-c', 'user.name=Cezar fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-qm', 'Cezar staging fixture',
  ]);
  return (await git(['rev-parse', 'HEAD'])).stdout.trim();
}

/** Exercise the candidate's real replay agent or judge against synthetic inputs only. */
export async function runHarnessRealReplaySuite(entry: string, needed: { agent: boolean; judge: boolean }) {
  const config = await loadWorkspaceConfig();
  return withStagingCockpit(entry, async (api, project) => {
    const samples: Array<{ name: string; passed: boolean }> = [];
    async function sample(name: string, check: () => Promise<boolean>): Promise<void> {
      samples.push({ name, passed: await check().catch(() => false) });
    }
    const create = async (input: object) => {
      const run = await stagingJson(api + '/runs', input);
      return runRecordSchema.parse(run);
    };
    if (needed.agent) await sample('authenticated Codex replay', async () => {
      const task = 'Read fixture.txt using the read-only file tool. Reply with the exact text and finish.';
      const original = (await settle(api, [await create({ task, workflow: 'plan', runner: 'codex' })], true))[0]!;
      if (!success(original) || !original.startCommit || !original.steps[0]?.sessionId) return false;
      // The terminal record can precede the final session teardown by one tick.
      await wait(500);
      const group = replayRunResponseSchema.parse(await stagingJson(api + '/runs/' + original.id + '/replay', {}));
      const replay = runRecordSchema.parse(await stagingJson(api + '/runs/' + group.runs[0]));
      const [settled] = await settle(api, [replay], true);
      return settled !== undefined && success(settled) && settled.startCommit === original.startCommit &&
        settled.steps[0]?.toolPolicy?.enforceReadOnly === true && Boolean(settled.steps[0]?.sessionId) &&
        readRunEvents(join(project, '.ai/cezar/runs', settled.id + '.ndjson'))
          .some(event => event.type === 'text' && typeof event.text === 'string' && event.text.includes('staging fixture marker'));
    });
    if (needed.judge) await sample('tool-free judge', async () => {
      const [run] = await settle(api, [await create({
        task: 'Print the staging fixture marker.',
        steps: [{ id: 'check', command: "printf 'staging fixture marker'" }],
      })]);
      if (!run || !success(run)) return false;
      const path = '/runs/' + run.id;
      await stagingJson(api + path + '/score', { scorer: 'outcome' });
      const deadline = Date.now() + 150_000;
      do {
        const { scores } = runScoresResponseSchema.parse(await stagingJson(api + path + '/scores'));
        if (scores.outcome?.status === 'scored') return scores.outcome.score.pass;
        if (scores.outcome?.status === 'error') return false;
        await wait(500);
      } while (Date.now() < deadline);
      return false;
    });
    return samples;
  }, {
    dryRun: false, scoring: needed.judge,
    prepare: async (project, workspace) => {
      await seedFixtureProject(project);
      await mkdir(workspace, { recursive: true });
      await writeFile(join(workspace, 'config.json'), JSON.stringify({
        projects: [],
        factory: {
          ...(config.factory?.judge ? { judge: config.factory.judge } : {}),
          scoring: { sampling: { outcome: 0, efficiency: 0, procedure: 0, scope: 0 } },
        },
      }), { mode: 0o600 });
    },
  });
}
