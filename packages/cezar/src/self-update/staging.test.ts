import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { smokeStagedHarness, withStagingCockpit } from './staging.ts';

const fixture = [
  "import { createServer } from 'node:http';",
  "const port = Number(process.argv[process.argv.indexOf('--port') + 1]);",
  "const run = { id: 'fixture', title: 'check', task: 'check', workflow: 'example',",
  "  createdAt: '2026-01-01T00:00:00.000Z', tokensUsed: 0, archived: false, steps: [] };",
  "createServer((req, res) => {",
  "  const payload = req.url === '/api/v1/health' ? { instanceId: process.env.CEZ_INSTANCE_ID }",
  "    : req.url === '/api/v1/isolated' ? { workspace: process.env.CEZ_HOME, cwd: process.cwd(),",
  "         runnerOverride: process.env.CEZ_OPENCODE_BIN, dry: process.env.CEZ_DRY_RUN, managers: process.env.CEZ_MANAGERS,",
  "         automations: process.env.CEZ_AUTOMATIONS, scoring: process.env.CEZ_SCORING, codexHome: process.env.CODEX_HOME }",
  "    : { ...run, status: req.method === 'POST' ? 'queued' : 'done' };",
  "  res.setHeader('content-type', 'application/json');",
  "  res.end(JSON.stringify(payload));",
  "}).listen(port, '127.0.0.1');",
].join('\n');

it('starts an independent cockpit and removes its workspace after a failed check', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-staging-test-'));
  vi.stubEnv('CEZ_OPENCODE_BIN', 'example-runner-override');
  try {
    const entry = join(root, 'fixture.mjs');
    await writeFile(entry, fixture);
    await smokeStagedHarness(entry);
    let scratch: string | undefined;
    let api: string | undefined;
    const use = async (url: string) => {
      api = url;
      const { workspace, cwd, ...modes } = await fetch(api + '/isolated').then((response) => response.json()) as {
        workspace: string;
        cwd: string;
        dry: string;
        managers: string;
        automations: string;
      };
      scratch = dirname(workspace);
      expect(workspace).not.toBe(process.env.CEZ_HOME);
      expect(cwd).toBe(join(scratch, 'project'));
      expect(modes).toEqual({ dry: '1', managers: '0', automations: '0', scoring: '0' });
      await access(scratch);
      throw new Error('fixture failed');
    };
    await expect(withStagingCockpit(entry, use)).rejects.toThrow('fixture failed');
    expect(scratch).toBeDefined();
    await expect(access(scratch!)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fetch(api + '/health')).rejects.toThrow();
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);

it('passes only the selected Codex home to an authenticated staging replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-staging-test-'));
  const codexHome = join(root, 'selected-profile');
  vi.stubEnv('CODEX_HOME', join(root, 'different-profile'));
  vi.stubEnv('CEZ_OPENCODE_BIN', 'example-runner-override');
  vi.stubEnv('CEZ_SCORING', '1');
  try {
    const entry = join(root, 'fixture.mjs');
    await writeFile(entry, fixture);
    const modes = await withStagingCockpit(entry, async (api) =>
      fetch(api + '/isolated').then((response) => response.json()), { dryRun: false, codexHome });
    expect(modes).toMatchObject({ dry: '0', managers: '0', automations: '0', scoring: '0', codexHome });
    expect(modes).not.toHaveProperty('runnerOverride');
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);
