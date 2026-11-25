import { execFile } from 'node:child_process';
import type { AzureRemote } from './remote.ts';

/**
 * Zero-config credentials for Azure DevOps Services (spec 2026-11-24-azure-repos-forge-driver D1/D2). In order:
 * `AZURE_DEVOPS_EXT_PAT` (the variable `az devops` reads), the credential git already holds for this remote
 * (`git credential fill`, never interactive), then an Entra token from `az account get-access-token`. Held in this
 * process's memory only — never written, never passed to an agent. Every failure is null plus a reason.
 */

/** Azure DevOps' Entra resource id (Microsoft docs: "Azure DevOps REST API with Microsoft Entra tokens"). */
export const ADO_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';
const TOOL_TIMEOUT_MS = 20_000;
const TOKEN_MARGIN_MS = 5 * 60_000;

export interface AzureCredential {
  header: string;
  source: 'env' | 'git' | 'az';
  /** Epoch ms after which it must be fetched again; absent = until a 401. */
  expiresAt?: number;
}

export type AzureAuthResult = { ok: true; credential: AzureCredential } | { ok: false; reason: string };

export type ToolRunner = (
  bin: string,
  args: string[],
  input?: string,
) => Promise<{ ok: boolean; stdout: string; notFound: boolean }>;

const runTool: ToolRunner = (bin, args, input) =>
  new Promise((resolve) => {
    const child = execFile(
      bin,
      args,
      {
        timeout: TOOL_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
        // Nobody can answer a prompt here: git and Git Credential Manager must never open one.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', AZURE_CORE_NO_COLOR: '1' },
      },
      (err, stdout) => resolve({ ok: !err, stdout: stdout ?? '', notFound: (err as NodeJS.ErrnoException | null)?.code === 'ENOENT' }),
    );
    child.stdin?.end(input ?? '');
  });

const basic = (user: string, secret: string) => `Basic ${Buffer.from(`${user}:${secret}`).toString('base64')}`;

/** The credential git's helper holds for this remote, or null. @internal */
export async function gitCredential(remote: AzureRemote, run: ToolRunner = runTool): Promise<AzureCredential | null> {
  const path = `${remote.org}/${remote.project}/_git/${remote.repo}`;
  const res = await run('git', ['credential', 'fill'], `protocol=https\nhost=dev.azure.com\npath=${path}\n\n`);
  if (!res.ok) return null;
  const fields = Object.fromEntries(
    res.stdout
      .split('\n')
      .map((line) => line.split(/=(.*)/s))
      .filter((pair): pair is [string, string] => pair.length >= 2 && pair[0] !== ''),
  );
  return fields.password ? { header: basic(fields.username ?? '', fields.password), source: 'git' } : null;
}

/** An Entra access token from the Azure CLI, or null. @internal */
export async function azCredential(run: ToolRunner = runTool, now = Date.now): Promise<AzureCredential | null> {
  const res = await run('az', ['account', 'get-access-token', '--resource', ADO_RESOURCE, '--output', 'json']);
  if (!res.ok) return null;
  try {
    const parsed = JSON.parse(res.stdout) as { accessToken?: unknown; expires_on?: unknown; expiresOn?: unknown };
    if (typeof parsed.accessToken !== 'string' || !parsed.accessToken) return null;
    const epoch = typeof parsed.expires_on === 'number' ? parsed.expires_on * 1000 : Date.parse(String(parsed.expiresOn ?? ''));
    const expiresAt = Number.isFinite(epoch) ? epoch - TOKEN_MARGIN_MS : now() + 30 * 60_000;
    return { header: `Bearer ${parsed.accessToken}`, source: 'az', expiresAt };
  } catch {
    return null;
  }
}

export interface AzureAuth {
  get(): Promise<AzureAuthResult>;
  /** Forget the held credential (after a 401), so the next `get` asks again. */
  invalidate(): void;
}

export function createAzureAuth(
  remote: AzureRemote,
  deps: { run?: ToolRunner; env?: NodeJS.ProcessEnv; now?: () => number } = {},
): AzureAuth {
  const run = deps.run ?? runTool;
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  let held: AzureCredential | null = null;
  let pending: Promise<AzureAuthResult> | null = null;

  const resolve = async (): Promise<AzureAuthResult> => {
    const pat = env.AZURE_DEVOPS_EXT_PAT?.trim();
    if (pat) return { ok: true, credential: { header: basic('', pat), source: 'env' } };
    const fromGit = await gitCredential(remote, run);
    if (fromGit) return { ok: true, credential: fromGit };
    const fromAz = await azCredential(run, now);
    if (fromAz) return { ok: true, credential: fromAz };
    return {
      ok: false,
      reason:
        'no Azure DevOps credential — push to this repository over HTTPS once (git keeps the credential), ' +
        'set AZURE_DEVOPS_EXT_PAT, or run `az login`',
    };
  };

  return {
    async get() {
      if (env.CEZ_DRY_RUN === '1') return { ok: false, reason: 'dry run — Azure DevOps is not called' };
      if (held && (!held.expiresAt || held.expiresAt > now())) return { ok: true, credential: held };
      pending ??= resolve().then((result) => {
        held = result.ok ? result.credential : null;
        pending = null;
        return result;
      });
      return pending;
    },
    invalidate() {
      held = null;
    },
  };
}
