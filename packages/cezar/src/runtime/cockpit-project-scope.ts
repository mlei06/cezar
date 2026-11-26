import { readdir, realpath } from 'node:fs/promises';
import { projectsResponseSchema } from '@open-mercato/cezar-contract';
import { cockpitRuntimeRoot, inspectCockpitRuntime } from './cockpit-runtime.ts';

export async function resolveCockpitProjectScope(repoRoot: string, env: NodeJS.ProcessEnv, fetcher: typeof fetch): Promise<string | undefined> {
  const explicit = env.CEZ_API_URL?.replace(/\/+$/, '');
  if (explicit && env.CEZ_PROJECT_ID) return `${explicit}/api/v1/p/${encodeURIComponent(env.CEZ_PROJECT_ID)}`;
  if (!explicit && (env.CEZ_TASK_ID || env.CEZ_MANAGER_ID)) return undefined;
  const origins = new Set(explicit ? [explicit] : []);
  if (!explicit) {
    const slots = await readdir(cockpitRuntimeRoot(env)).catch(() => []);
    for (const slot of slots) {
      const probe = await inspectCockpitRuntime(slot, { env, fetcher }).catch(() => undefined);
      if (probe?.kind === 'verified') origins.add(probe.runtime.origin);
    }
  }
  const root = await realpath(repoRoot).catch(() => repoRoot);
  for (const origin of origins) {
    try {
      const response = await fetcher(`${origin}/api/v1/projects`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) continue;
      const result = projectsResponseSchema.safeParse(await response.json());
      if (!result.success) continue;
      const project = result.data.projects.find((candidate) => candidate.root === root && candidate.status !== 'missing');
      if (project) return `${origin}/api/v1/p/${encodeURIComponent(project.id)}`;
    } catch {
      // A vanished cockpit does not prevent trying the remaining verified slots.
    }
  }
  return undefined;
}
