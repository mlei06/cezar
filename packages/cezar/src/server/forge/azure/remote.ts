/**
 * Azure DevOps Services remotes (spec 2026-11-24-azure-repos-forge-driver; forms as in the provider spec's
 * Discovery, #1617). Plain string parsing — no network, no CLI. Server (on-premises) remotes are out of scope and
 * parse to null.
 */

export interface AzureRemote {
  /** Always `dev.azure.com`: the REST host, whichever form the remote used. */
  host: 'dev.azure.com';
  org: string;
  project: string;
  repo: string;
}

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

const make = (org?: string, project?: string, repo?: string): AzureRemote | null =>
  org && project && repo
    ? { host: 'dev.azure.com', org: decode(org), project: decode(project), repo: decode(repo.replace(/\.git$/i, '')) }
    : null;

/** `{org, project, repo}` of an Azure DevOps Services remote, or null for anything else. */
export function parseAzureRemote(remote: string | undefined): AzureRemote | null {
  if (!remote) return null;
  const r = remote.trim().replace(/\/+$/, '');
  // https://[user[:secret]@]dev.azure.com/{org}/{project}/_git/{repo}
  let m = /^https?:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+)$/i.exec(r);
  if (m) return make(m[1], m[2], m[3]);
  // https://[user@]{org}.visualstudio.com/[DefaultCollection/]{project}/_git/{repo}
  m = /^https?:\/\/(?:[^@/]+@)?([^./@]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/?#]+)$/i.exec(r);
  if (m) return make(m[1], m[2], m[3]);
  // git@ssh.dev.azure.com:v3/{org}/{project}/{repo} (also ssh://…/v3/…)
  m = /^(?:ssh:\/\/)?(?:[^@/]+@)?ssh\.dev\.azure\.com[:/]v3\/([^/]+)\/([^/]+)\/([^/]+)$/i.exec(r);
  if (m) return make(m[1], m[2], m[3]);
  // {org}@vs-ssh.visualstudio.com:v3/{org}/{project}/{repo}
  m = /^(?:ssh:\/\/)?(?:[^@/]+@)?vs-ssh\.visualstudio\.com[:/]v3\/([^/]+)\/([^/]+)\/([^/]+)$/i.exec(r);
  if (m) return make(m[1], m[2], m[3]);
  return null;
}

const seg = (s: string) => encodeURIComponent(s);

/** The repository's web root, rebuilt from the parsed parts so no credential in the remote can leak. */
export function azureWebRoot(remote: AzureRemote): string {
  return `https://dev.azure.com/${seg(remote.org)}/${seg(remote.project)}/_git/${seg(remote.repo)}`;
}

/** The project's web root (work items live here, not under the repository). */
export function azureProjectRoot(remote: AzureRemote): string {
  return `https://dev.azure.com/${seg(remote.org)}/${seg(remote.project)}`;
}
