import { execFile } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { promisify } from 'node:util';
import { createRunResponseSchema, runRecordSchema, type RunRecord, type CreateRunInput } from '@open-mercato/cezar-contract';
import { stagingJson, withStagingCockpit } from '../self-update/staging.ts';

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

async function settle(api: string, initial: RunRecord[]): Promise<RunRecord[]> {
  const end = Date.now() + 25_000;
  for (;;) {
    const runs = await Promise.all(initial.map(async ({ id }) =>
      runRecordSchema.parse(await stagingJson(api + '/runs/' + encodeURIComponent(id)))));
    if (runs.every((run) => success(run) || run.status === 'failed' || run.status === 'cancelled')) return runs;
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
  }, async (project) => {
    await exec('git', ['init', '-q'], { cwd: project });
    await exec('git', [
      '-c', 'core.hooksPath=.no-hooks', '-c', 'commit.gpgSign=false',
      '-c', 'user.name=Cezar fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '-qm', 'Cezar staging fixture', '--allow-empty',
    ], { cwd: project });
    projectCommit = (await exec('git', ['rev-parse', 'HEAD'], { cwd: project })).stdout.trim();
  });
}
