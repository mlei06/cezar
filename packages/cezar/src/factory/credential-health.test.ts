import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { AutomationStore } from '../automations/store.ts';
import { RunStore } from '../runs/store.ts';
import { CREDENTIAL_HEALTH, credentialHealthWorkflowIssue, ensureCredentialHealthAutomation, recordCredentialFailure } from './credential-health.ts';

it('registers one disabled daily check and records a redacted access finding for a failed bound check', () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-credential-check-'));
  const dataDir = join(root, '.ai/cezar');
  const runs = RunStore.open(dataDir);
  try {
    const store = AutomationStore.open(dataDir);
    ensureCredentialHealthAutomation(store, root);
    expect(store.list()).toEqual([]);
    mkdirSync(join(dataDir, 'workflows'), { recursive: true });
    writeFileSync(join(dataDir, 'workflows', CREDENTIAL_HEALTH + '.yaml'), 'fixture');
    ensureCredentialHealthAutomation(store, root);
    ensureCredentialHealthAutomation(store, root);
    expect(store.list()).toMatchObject([{
      name: 'Credential health', kind: 'schedule', enabled: false,
      schedule: { type: 'daily' }, task: { workflow: CREDENTIAL_HEALTH },
    }]);

    const check = { id: 'api', name: 'API probe', command: 'exit 1', secrets: ['SERVICE_TOKEN'] };
    const workflowDef = { name: CREDENTIAL_HEALTH, source: 'file' as const, steps: [check] };
    expect(credentialHealthWorkflowIssue(workflowDef)).toBeUndefined();
    expect(credentialHealthWorkflowIssue({ ...workflowDef, steps: [{ ...check, secrets: undefined }] })).toMatch(/explicit secret/);
    expect(credentialHealthWorkflowIssue({ ...workflowDef, steps: [{ id: 'agent', prompt: 'Look' }] })).toMatch(/check-only/);
    const run = runs.createRun({ title: 'Credential health', task: 'Check', workflow: CREDENTIAL_HEALTH, steps: [{ ...check, kind: 'check' }] });
    runs.updateStep(run.id, check.id, { status: 'failed' });
    const finishedAt = '2026-11-26T12:00:00.000Z';
    const failed = runs.updateRun(run.id, { status: 'failed', workflowDef, finishedAt, error: 'raw vendor output' });
    if (!failed) throw new Error('Missing run');
    const first = recordCredentialFailure(dataDir, 'example', failed);
    const second = recordCredentialFailure(dataDir, 'example', failed);
    expect(first).toEqual(second);
    expect(first[0]).toMatchObject({ cause: { category: 'access', target: 'infra' } });
    expect(readFileSync(join(dataDir, 'factory', CREDENTIAL_HEALTH, first[0]!.id + '.json'), 'utf8')).not.toContain('raw vendor output');
  } finally {
    runs.flush();
    rmSync(root, { recursive: true, force: true });
  }
});
