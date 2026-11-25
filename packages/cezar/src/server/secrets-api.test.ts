import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { secretsListSchema } from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { registerProject } from '../workspace/projects.ts';
import { SecretStore } from '../workspace/secrets.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

describe('secrets API (spec 2026-10-10-project-secrets-vault-options)', () => {
  let root: string;
  let store: RunStore;
  let secrets: SecretStore;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-secrets-api-'));
    vi.stubEnv('CEZ_HOME', join(root, 'home'));
    vi.stubEnv('CEZ_SINGLE_PROJECT', '0');
    mkdirSync(join(root, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(root, '.ai/cezar'));
    secrets = new SecretStore(process.env, { keychain: async () => null });
  });
  afterEach(() => {
    store.flush();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  const app = async () => {
    const project = await registerProject(root);
    return {
      id: project.id,
      instance: createApp({ repoRoot: root, store, manager: {} as RunManager, version: 'test', bootProjectId: project.id, secrets }),
    };
  };
  const put = (body: unknown): RequestInit => ({
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  it('stores a project secret, answers metadata only, and deletes it', async () => {
    const { id, instance } = await app();
    expect((await apiRequest(instance, '/api/v1/secrets/E2E_KEY', put({ value: 'secret-value-123' }))).status).toBe(204);
    expect((await apiRequest(instance, '/api/v1/secrets/LLM_KEY', put({ value: 'llm-value-123', audiences: ['cezar'] }))).status).toBe(204);

    for (const path of ['/api/v1/secrets', `/api/v1/p/${id}/secrets`]) {
      const response = await apiRequest(instance, path);
      expect(response.status).toBe(200);
      const text = await response.text();
      // The value never comes back, in any form.
      expect(text).not.toMatch(/secret-value-123|llm-value-123/);
      const body = secretsListSchema.parse(JSON.parse(text));
      expect(body.keyBackend).toBe('file');
      expect(body.secrets.map((s) => [s.name, s.audiences])).toEqual([['E2E_KEY', ['checks', 'agents']], ['LLM_KEY', ['cezar']]]);
    }
    const raw = readFileSync(join(root, 'home', 'secrets', `${id}.json`), 'utf8');
    expect(raw).toContain('"E2E_KEY"');
    expect(raw).not.toContain('secret-value-123');

    expect((await apiRequest(instance, `/api/v1/p/${id}/secrets/E2E_KEY`, { method: 'DELETE' })).status).toBe(204);
    expect((await apiRequest(instance, '/api/v1/secrets/E2E_KEY', { method: 'DELETE' })).status).toBe(404);
    expect(secretsListSchema.parse(await (await apiRequest(instance, '/api/v1/secrets')).json()).secrets.map((s) => s.name)).toEqual(['LLM_KEY']);
  });

  it('keeps workspace secrets apart from the project\'s, single-mount', async () => {
    const { id, instance } = await app();
    expect((await apiRequest(instance, '/api/v1/workspace/secrets/SHARED', put({ value: 'workspace-value-123' }))).status).toBe(204);
    const listed = secretsListSchema.parse(await (await apiRequest(instance, '/api/v1/workspace/secrets')).json());
    expect(listed.secrets.map((s) => s.name)).toEqual(['SHARED']);
    expect(secretsListSchema.parse(await (await apiRequest(instance, '/api/v1/secrets')).json()).secrets).toEqual([]);
    expect((await apiRequest(instance, `/api/v1/p/${id}/workspace/secrets`)).status).toBe(404);
    expect((await apiRequest(instance, '/api/v1/workspace/secrets/SHARED', { method: 'DELETE' })).status).toBe(204);
    expect((await apiRequest(instance, '/api/v1/workspace/secrets/SHARED', { method: 'DELETE' })).status).toBe(404);
  });

  it('updates descriptions independently in both scopes and accepts old records', async () => {
    const { id, instance } = await app();
    const patch = (body: unknown): RequestInit => ({ ...put(body), method: 'PATCH' });
    for (const [path, file] of [
      [`/api/v1/p/${id}/secrets`, `${id}.json`],
      ['/api/v1/workspace/secrets', 'workspace.json'],
    ] as const) {
      const url = `${path}/KEY`;
      const list = async () => (await (await apiRequest(instance, path)).json()) as { secrets: object[] };
      const persisted = () => JSON.parse(readFileSync(join(root, 'home', 'secrets', file), 'utf8')).secrets.KEY;
      expect((await apiRequest(instance, url, patch({ description: 'Missing' }))).status).toBe(404);
      expect((await apiRequest(instance, url, put({ value: 'original-value', audiences: ['checks'] }))).status).toBe(204);
      expect((await list()).secrets[0]).not.toHaveProperty('description');
      const original = persisted();
      const description = 'd'.repeat(200);
      expect((await apiRequest(instance, url, patch({ description: description + 'd' }))).status).toBe(400);
      expect((await apiRequest(instance, url, patch({ description, value: 'ignored' }))).status).toBe(400);
      expect((await apiRequest(instance, url, put({ value: 'new-value', description: description + 'd' }))).status).toBe(400);
      expect(persisted()).toEqual(original);
      expect((await apiRequest(instance, url, patch({ description }))).status).toBe(204);
      expect(persisted()).toEqual({ ...original, description, updatedAt: expect.any(String) });
      expect((await list()).secrets).toEqual([{ name: 'KEY', audiences: ['checks'], description, updatedAt: expect.any(String) }]);
      expect((await apiRequest(instance, url, put({ value: 'new-value' }))).status).toBe(204);
      expect((await list()).secrets[0]).toHaveProperty('description', description);
      expect((await apiRequest(instance, url, put({ value: 'newer-value', description: 'Replacement' }))).status).toBe(204);
      expect((await list()).secrets[0]).toHaveProperty('description', 'Replacement');
      expect((await apiRequest(instance, url, patch({ description: '' }))).status).toBe(204);
      expect((await list()).secrets[0]).not.toHaveProperty('description');
    }
  });

  it('refuses a bad name, value or audience with a 400 naming the reason', async () => {
    const { instance } = await app();
    for (const [name, reason] of [
      ['CEZ_RUN_ID', 'reserved'],
      ['PATH', 'refused'],
      ['DYLD_INSERT_LIBRARIES', 'refused'],
      ['lower', 'uppercase'],
    ] as const) {
      const response = await apiRequest(instance, `/api/v1/secrets/${name}`, put({ value: 'x' }));
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toContain(reason);
    }
    expect((await apiRequest(instance, '/api/v1/secrets/KEY', put({ value: 'a\nB=b' }))).status).toBe(400);
    // An empty value is refused here too: the CLI and the cockpit both refuse it, and storing
    // an empty string would shadow the server's own variable of that name instead of reading as unset.
    const empty = await apiRequest(instance, '/api/v1/secrets/KEY', put({ value: '' }));
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error: string }).error).toContain('not empty');
    expect((await apiRequest(instance, '/api/v1/secrets/KEY', put({ value: 'x'.repeat(16 * 1024 + 1) }))).status).toBe(400);
    expect((await apiRequest(instance, '/api/v1/secrets/KEY', put({ value: 42 }))).status).toBe(400);
    expect((await apiRequest(instance, '/api/v1/secrets/KEY', put({ value: 'ok', audiences: [] }))).status).toBe(400);
    expect((await apiRequest(instance, '/api/v1/secrets/KEY', put({ value: 'ok', audiences: ['nobody'] }))).status).toBe(400);
    expect(secretsListSchema.parse(await (await apiRequest(instance, '/api/v1/secrets')).json()).secrets).toEqual([]);
  });

  it('refuses project writes for an unregistered boot project, and still serves the workspace', async () => {
    const instance = createApp({ repoRoot: root, store, manager: {} as RunManager, version: 'test', secrets });
    expect((await apiRequest(instance, '/api/v1/secrets/KEY', put({ value: 'value' }))).status).toBe(409);
    expect((await apiRequest(instance, '/api/v1/secrets/KEY', { method: 'DELETE' })).status).toBe(409);
    expect((await apiRequest(instance, '/api/v1/workspace/secrets/KEY', put({ value: 'value' }))).status).toBe(204);
  });
});
