import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSecretsCommand } from './secrets-cli.ts';
import { SecretStore } from './secrets.ts';
import { registerProject } from './projects.ts';

describe('cezar secrets (spec 2026-10-10-project-secrets-vault-options)', () => {
  let root: string;
  let lines: string[];
  let errors: string[];
  let store: SecretStore;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-secrets-cli-'));
    vi.stubEnv('CEZ_HOME', join(root, 'home'));
    lines = [];
    errors = [];
    store = new SecretStore(process.env, { keychain: async () => null });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  const cli = (args: string[], value?: string) =>
    runSecretsCommand([...args, '--repo', root], {
      log: (line) => lines.push(line),
      error: (line) => errors.push(line),
      ...(value === undefined ? {} : { readValue: async () => value }),
    }, process.env, store);

  it('sets from stdin, lists names with audiences and the key backend, and unsets — never a value', async () => {
    await registerProject(root);
    expect(await cli(['set', 'E2E_KEY'], 'cli-secret-value')).toBe(0);
    expect(await cli(['set', 'LLM_KEY', '--audience', 'cezar,checks'], 'cli-llm-value')).toBe(0);
    expect(await cli(['list'])).toBe(0);
    expect(await cli(['unset', 'E2E_KEY'])).toBe(0);
    expect(await cli(['list'])).toBe(0);
    expect(lines).toEqual(['E2E_KEY', 'LLM_KEY', 'E2E_KEY\tchecks,agents', 'LLM_KEY\tcezar,checks', 'E2E_KEY', 'LLM_KEY\tcezar,checks']);
    expect(errors.some((line) => /key file|keychain/.test(line))).toBe(true);
    expect([...lines, ...errors].join('\n')).not.toMatch(/cli-secret-value|cli-llm-value/);
  });

  it('addresses the workspace with --workspace, without needing a registered project', async () => {
    expect(await cli(['set', 'SHARED', '--workspace'], 'workspace-value')).toBe(0);
    expect(await cli(['list', '--workspace'])).toBe(0);
    expect(lines).toEqual(['SHARED', 'SHARED\tchecks,agents']);
    expect((await store.read({ kind: 'workspace' })).values.SHARED?.value).toBe('workspace-value');
    expect(await cli(['list'])).toBe(1);
    expect(errors.at(-1)).toContain('not a registered cezar project');
  });

  it('never takes a value from argv, and refuses any other operand or flag shape', async () => {
    await registerProject(root);
    expect(await cli(['set', 'E2E_KEY', 'inline-value'])).toBe(1);
    expect(errors.join('\n')).toContain('Usage');
    for (const args of [[], ['list', 'EXTRA'], ['set'], ['unset'], ['nonsense'], ['set', 'K', '--audience'],  ['set', 'K', '--audience', 'nobody'], ['unset', 'K', '--audience', 'checks']]) {
      expect(await cli(args, 'v')).toBe(1);
      expect(errors.at(-1)).toContain('Usage');
    }
  });

  it('accepts a description on set and edits it without reading stdin', async () => {
    const scope = { kind: 'workspace' } as const;
    const max = 'x'.repeat(200);
    const tooLong = 'x'.repeat(201);
    expect(await cli(['set', 'KEY', '--workspace', '--description', tooLong])).toBe(1);
    expect(errors.at(-1)).toContain('at most 200 characters');
    expect(await cli(['set', 'KEY', '--workspace', '--description', max], 'original-value')).toBe(0);
    expect((await store.list(scope)).secrets[0]?.description).toBe(max);
    expect(await cli(['describe', 'KEY', tooLong, '--workspace'])).toBe(1);
    expect(await cli(['describe', 'KEY', 'Deployment token', '--workspace'])).toBe(0);
    expect((await store.read(scope)).values.KEY).toMatchObject({
      value: 'original-value', description: 'Deployment token', audiences: ['checks', 'agents'],
    });
    expect(await cli(['describe', 'KEY', '', '--workspace'])).toBe(0);
    expect((await store.list(scope)).secrets[0]).not.toHaveProperty('description');
    expect(await cli(['describe', 'MISSING', max, '--workspace'])).toBe(1);
    expect(errors.at(-1)).toContain('no secret named MISSING');
    expect(lines).toEqual(['KEY', 'KEY', 'KEY']);
  });

  it('rejects options as separated descriptions before reading or writing', async () => {
    await registerProject(root);
    const readValue = vi.fn(async () => 'new-value');
    const set = vi.spyOn(store, 'set');
    for (const option of ['--workspace', '--repo', '--audience', '--description', '--description=text']) {
      expect(await runSecretsCommand(['set', 'KEY', '--repo', root, '--description', option], {
        log: (line) => lines.push(line), error: (line) => errors.push(line), readValue,
      }, process.env, store)).toBe(1);
      expect(errors.at(-1)).toContain('Usage');
    }
    expect(readValue).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it('describes the project entry by default even when the workspace has the same name', async () => {
    const { id } = await registerProject(root);
    const project = { kind: 'project', projectId: id, root } as const;
    const workspace = { kind: 'workspace' } as const;
    expect(await cli(['set', 'KEY', '--workspace', '--description', 'Shared key'], 'workspace-value')).toBe(0);
    expect(await cli(['set', 'KEY', '--description=--workspace'], 'project-value')).toBe(0);
    expect((await store.list(project)).secrets[0]?.description).toBe('--workspace');
    expect(await cli(['describe', 'KEY', 'Project key'])).toBe(0);
    expect((await store.read(project)).values.KEY).toMatchObject({ description: 'Project key', value: 'project-value' });
    expect(await cli(['set', 'KEY', '--description='], 'project-value')).toBe(0);
    expect((await store.list(project)).secrets[0]).not.toHaveProperty('description');
    expect(await cli(['set', 'KEY', '--description=text'], 'project-value')).toBe(0);
    expect(await cli(['set', 'KEY', '--description', ''], 'project-value')).toBe(0);
    expect((await store.list(project)).secrets[0]).not.toHaveProperty('description');
    expect((await store.read(workspace)).values.KEY).toMatchObject({ description: 'Shared key', value: 'workspace-value' });
  });

  it('prints a value with get (project over workspace) and agents secrets as exports with env', async () => {
    await registerProject(root);
    expect(await cli(['set', 'SSH_USER', '--workspace'], 'ws-user')).toBe(0);
    expect(await cli(['set', 'SSH_USER'], "proj'user")).toBe(0);
    expect(await cli(['set', 'CHECK_ONLY', '--audience', 'checks'], 'c-only')).toBe(0);
    lines.length = 0;
    expect(await cli(['get', 'SSH_USER'])).toBe(0);
    expect(await cli(['get', 'SSH_USER', '--workspace'])).toBe(0);
    expect(await cli(['get', 'CHECK_ONLY'])).toBe(0);
    expect(await cli(['env'])).toBe(0);
    expect(lines).toEqual(["proj'user", 'ws-user', 'c-only', `export SSH_USER='proj'\\''user'`]);
    expect(await cli(['get', 'MISSING'])).toBe(1);
    await cli(['unset', 'SSH_USER', '--workspace']);
  });

  it('refuses a reserved name, reports a missing name and an empty value', async () => {
    await registerProject(root);
    expect(await cli(['set', 'CEZ_RUN_ID'], 'x')).toBe(1);
    expect(errors.at(-1)).toContain('reserved');
    expect(await cli(['unset', 'MISSING'])).toBe(1);
    expect(errors.at(-1)).toContain('no secret named MISSING');
    expect(await cli(['set', 'E2E_KEY'], '')).toBe(1);
    expect(errors.at(-1)).toContain('empty value');
  });
});
