import type { AzureAuth } from './auth.ts';
import type { AzureRemote } from './remote.ts';

/**
 * Azure DevOps REST transport (spec 2026-11-24-azure-repos-forge-driver D3). The only place a URL is assembled:
 * every path segment is encoded. Never throws — every failure is `{ok: false, status, reason}`; a 401 drops the
 * held credential and retries once.
 */

const API_VERSION = '7.1';
const DEADLINE_MS = 20_000;
const BODY_CAP = 4 * 1024 * 1024;

export type AzureResponse<T = unknown> =
  | { ok: true; status: number; json: T }
  | { ok: false; status: number; reason: string };

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface AzureTransport {
  request<T = unknown>(
    method: 'GET' | 'POST' | 'PATCH',
    path: readonly string[],
    opts?: { query?: Record<string, string | number | undefined>; body?: unknown },
  ): Promise<AzureResponse<T>>;
}

/** The REST URL for a project-scoped path. @internal */
export function azureApiUrl(
  remote: AzureRemote,
  path: readonly string[],
  query: Record<string, string | number | undefined> = {},
): string {
  const base = `https://dev.azure.com/${encodeURIComponent(remote.org)}/${encodeURIComponent(remote.project)}/_apis/`;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, String(v));
  params.set('api-version', API_VERSION);
  return `${base}${path.map(encodeURIComponent).join('/')}?${params}`;
}

/** A one-line reason from an Azure DevOps error body (`{message}`), else the status. */
function reasonOf(status: number, text: string): string {
  try {
    const message = (JSON.parse(text) as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message.trim().split('\n')[0]!.slice(0, 300);
  } catch {
    // not JSON — fall through
  }
  if (status === 401) return 'Azure DevOps refused the credential (401) — sign in again or refresh the PAT';
  if (status === 403) return 'this identity cannot do that in Azure DevOps (403)';
  if (status === 404) return 'not found in Azure DevOps (404) — check the remote and your access to the project';
  return `Azure DevOps answered HTTP ${status}`;
}

export function createAzureTransport(remote: AzureRemote, auth: AzureAuth, fetchImpl: Fetch = fetch): AzureTransport {
  const once = async <T>(
    method: string,
    url: string,
    body: unknown,
  ): Promise<AzureResponse<T> & { unauthorized?: boolean }> => {
    const credential = await auth.get();
    if (!credential.ok) return { ok: false, status: 0, reason: credential.reason };
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(DEADLINE_MS),
        headers: {
          Authorization: credential.credential.header,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      const name = (err as Error)?.name;
      return {
        ok: false,
        status: 0,
        reason: name === 'TimeoutError' ? 'Azure DevOps did not answer in time' : 'cannot reach Azure DevOps (offline?)',
      };
    }
    const text = await res.text().catch(() => '');
    if (text.length > BODY_CAP) return { ok: false, status: res.status, reason: 'Azure DevOps answered more than cezar reads' };
    // An expired or revoked credential answers 401, or a 203 sign-in page instead of JSON.
    if (res.status === 401 || res.status === 203) return { ok: false, status: 401, reason: reasonOf(401, ''), unauthorized: true };
    if (!res.ok) return { ok: false, status: res.status, reason: reasonOf(res.status, text) };
    try {
      return { ok: true, status: res.status, json: (text ? JSON.parse(text) : {}) as T };
    } catch {
      return { ok: false, status: res.status, reason: 'Azure DevOps answered something that is not JSON' };
    }
  };

  return {
    async request(method, path, opts = {}) {
      const url = azureApiUrl(remote, path, opts.query);
      const first = await once(method, url, opts.body);
      if (!first.ok && first.unauthorized) {
        auth.invalidate();
        const second = await once(method, url, opts.body);
        const { unauthorized: _drop, ...rest } = second;
        return rest as AzureResponse<never>;
      }
      const { unauthorized: _drop, ...rest } = first;
      return rest as AzureResponse<never>;
    },
  };
}
