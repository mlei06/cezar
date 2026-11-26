import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { runRecordSchema } from '@open-mercato/cezar-contract';

// In particular, a host runner override can take precedence over CEZ_DRY_RUN.
const stagingEnvironment = () => Object.fromEntries(
  ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT']
    .flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]),
);

async function loopbackPort(): Promise<number> {
  const socket = createServer();
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address();
      socket.close((error) => {
        if (error) reject(error);
        else if (!address || typeof address === 'string') reject(new Error('Cannot allocate a staging port.'));
        else resolve(address.port);
      });
    });
  });
}

export async function stagingJson(url: string, body?: unknown): Promise<unknown> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(3_000),
    redirect: 'error',
    ...(body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }),
  });
  if (!response.ok) throw new Error('Staging cockpit returned HTTP ' + response.status + '.');
  return response.json();
}

/** Boot the candidate without the live project registry, managers or scheduler. */
export async function withStagingCockpit<T>(
  entry: string,
  use: (api: string) => Promise<T>,
  prepare?: (project: string) => Promise<void>,
): Promise<T> {
  const scratch = await mkdtemp(join(tmpdir(), 'cez-staging-'));
  try {
    const project = join(scratch, 'project');
    await mkdir(project);
    await prepare?.(project);
    const port = await loopbackPort();
    const instanceId = 'staging-' + randomUUID();
    const api = 'http://127.0.0.1:' + port + '/api/v1';
    const child = spawn(process.execPath, [entry, 'serve', '--repo', project, '--port', String(port), '--bind-host', '127.0.0.1', '--no-open'], {
      cwd: project,
      env: {
        ...stagingEnvironment(),
        CEZ_HOME: join(scratch, 'workspace'),
        CEZ_INSTANCE_ID: instanceId,
        CEZ_REMOTE: '0',
        CEZ_DRY_RUN: '1',
        CEZ_NO_BANNER: '1',
        CEZ_AUTOMATIONS: '0',
        CEZ_MANAGERS: '0',
        CEZ_AUTO_PROJECT_MANAGERS: '0',
        CEZ_RELAY: '0',
        CEZ_TELEMETRY: '0',
        CEZ_SKILLS_AUTO_UPDATE: '0',
        CEZ_WEBHOOKS: '0',
        CEZ_SUPERVISED: '0',
      },
      stdio: 'ignore',
    });
    let stopped = false;
    const exited = new Promise<void>((resolve) => {
      const exit = () => { stopped = true; resolve(); };
      child.once('exit', exit);
      child.once('error', exit);
    });
    try {
      const end = Date.now() + 30_000;
      while (!stopped && Date.now() < end) {
        const health = await stagingJson(api + '/health').catch(() => undefined);
        if (health && typeof health === 'object' && 'instanceId' in health && health.instanceId === instanceId) {
          return await use(api);
        }
        await wait(250);
      }
      throw new Error(stopped ? 'The staging cockpit exited during startup.' : 'The staging cockpit did not become ready.');
    } finally {
      if (!stopped) {
        child.kill('SIGTERM');
        await Promise.race([exited, wait(2_000, undefined, { ref: false })]);
        if (!stopped) {
          child.kill('SIGKILL');
          await exited;
        }
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** A single admitted task makes health check the run engine, not only the listener. */
export async function smokeStagedHarness(entry: string): Promise<void> {
  await withStagingCockpit(entry, async (api) => {
    const run = runRecordSchema.parse(await stagingJson(api + '/runs', {
      task: 'Check staging task admission and execution.',
      steps: [{ id: 'check', command: 'true' }],
    }));
    const end = Date.now() + 30_000;
    while (Date.now() < end) {
      const current = runRecordSchema.parse(await stagingJson(api + '/runs/' + encodeURIComponent(run.id)));
      if (current.status === 'done' || current.status === 'review') return;
      if (current.status === 'failed' || current.status === 'cancelled') break;
      await wait(250);
    }
    throw new Error('The staged smoke task did not complete successfully.');
  });
}
