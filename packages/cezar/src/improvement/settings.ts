import type { FactoryImprovementSettings, ImprovementScope } from '@open-mercato/cezar-contract';

/** Effective self-improvement policy for one queue (spec D6, D7 defaults for a one-person factory). */
export interface ImprovementSettings {
  enabled: boolean;
  threshold: number;
  ageDays: number;
  minForAge: number;
  /** Scored runs after a merge that end the cooldown. */
  cooldownRuns: number;
  /** Days after a merge that end the cooldown; undefined means runs only (the harness). */
  cooldownDays?: number;
  approval: 'manager' | 'owner' | 'none';
  scope: ImprovementScope[];
}

const ALL_SCOPE: ImprovementScope[] = ['docs', 'agents-md', 'skills', 'workflows', 'code'];

export function improvementDefaults(harness: boolean): ImprovementSettings {
  return harness
    ? { enabled: true, threshold: 5, ageDays: 7, minForAge: 2, cooldownRuns: 10, approval: 'manager', scope: [...ALL_SCOPE] }
    : { enabled: true, threshold: 5, ageDays: 3, minForAge: 2, cooldownRuns: 5, cooldownDays: 3, approval: 'manager', scope: [...ALL_SCOPE] };
}

/** Defaults, then the workspace's settings, then the project's; `CEZ_SELF_IMPROVEMENT=0` turns it off. */
export function resolveImprovementSettings(input: {
  harness: boolean;
  workspace?: FactoryImprovementSettings;
  project?: FactoryImprovementSettings;
  env?: NodeJS.ProcessEnv;
}): ImprovementSettings {
  const resolved = improvementDefaults(input.harness);
  for (const layer of [input.workspace, input.project]) {
    if (!layer) continue;
    for (const key of ['enabled', 'threshold', 'ageDays', 'minForAge', 'cooldownRuns', 'cooldownDays', 'approval'] as const) {
      if (layer[key] !== undefined) (resolved as unknown as Record<string, unknown>)[key] = layer[key];
    }
    if (layer.scope !== undefined) resolved.scope = [...new Set(layer.scope)];
  }
  if ((input.env ?? process.env).CEZ_SELF_IMPROVEMENT === '0') resolved.enabled = false;
  return resolved;
}
