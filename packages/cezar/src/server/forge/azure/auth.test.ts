import { describe, expect, it } from 'vitest';
import { createAzureAuth, type ToolRunner } from './auth.ts';

const remote = { host: 'dev.azure.com' as const, org: 'acme', project: 'shop', repo: 'web' };
const decode = (header: string) => Buffer.from(header.replace(/^Basic /, ''), 'base64').toString();

function runner(answers: Record<string, { ok: boolean; stdout?: string }>) {
  const calls: Array<{ bin: string; args: string[]; input?: string }> = [];
  const run: ToolRunner = async (bin, args, input) => {
    calls.push({ bin, args, input });
    const a = answers[bin] ?? { ok: false };
    return { ok: a.ok, stdout: a.stdout ?? '', notFound: false };
  };
  return { run, calls };
}

describe('createAzureAuth (spec 2026-11-24-azure-repos-forge-driver D1)', () => {
  it('prefers AZURE_DEVOPS_EXT_PAT and runs nothing', async () => {
    const { run, calls } = runner({});
    const result = await createAzureAuth(remote, { run, env: { AZURE_DEVOPS_EXT_PAT: 'pat-1' } }).get();
    expect(result.ok && result.credential.source).toBe('env');
    expect(result.ok && decode(result.credential.header)).toBe(':pat-1');
    expect(calls).toEqual([]);
  });

  it("then reads the credential git already holds for this remote, never interactively", async () => {
    const { run, calls } = runner({ git: { ok: true, stdout: 'protocol=https\nhost=dev.azure.com\nusername=me\npassword=tok=en\n' } });
    const result = await createAzureAuth(remote, { run, env: {} }).get();
    expect(result.ok && result.credential.source).toBe('git');
    expect(result.ok && decode(result.credential.header)).toBe('me:tok=en');
    expect(calls[0]).toMatchObject({ bin: 'git', args: ['credential', 'fill'] });
    expect(calls[0]!.input).toBe('protocol=https\nhost=dev.azure.com\npath=acme/shop/_git/web\n\n');
  });

  it('then asks az for an Entra token, which expires', async () => {
    const { run } = runner({
      git: { ok: false },
      az: { ok: true, stdout: JSON.stringify({ accessToken: 'jwt', expires_on: 2_000_000 }) },
    });
    let now = 1_000_000_000;
    const auth = createAzureAuth(remote, { run, env: {}, now: () => now });
    const first = await auth.get();
    expect(first.ok && first.credential).toMatchObject({ header: 'Bearer jwt', source: 'az' });
    now = 2_000_000_000; // past expiry: asked again
    await auth.get();
  });

  it('says what to do when nothing has a credential', async () => {
    const { run } = runner({});
    const result = await createAzureAuth(remote, { run, env: {} }).get();
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/AZURE_DEVOPS_EXT_PAT|az login/);
  });

  it('holds a credential until invalidated', async () => {
    const { run, calls } = runner({ git: { ok: true, stdout: 'password=p\n' } });
    const auth = createAzureAuth(remote, { run, env: {} });
    await auth.get();
    await auth.get();
    expect(calls).toHaveLength(1);
    auth.invalidate();
    await auth.get();
    expect(calls).toHaveLength(2);
  });

  it('never looks anything up in a dry run', async () => {
    const { run, calls } = runner({ git: { ok: true, stdout: 'password=p\n' } });
    const result = await createAzureAuth(remote, { run, env: { CEZ_DRY_RUN: '1', AZURE_DEVOPS_EXT_PAT: 'x' } }).get();
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});
