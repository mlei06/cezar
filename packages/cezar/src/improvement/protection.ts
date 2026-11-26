import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Owner-protected repository paths (spec D6 "Approval", D9): the scorers, the self-improvement
 * workflow and skill, and the harness's own release workflow. A manager never merges a change to
 * them on its own; the owner approves. Judge settings and secrets live outside the repository.
 */
const PROTECTED_DIRS = ['.ai/cezar/scorers/'];
const PROTECTED_WORKFLOWS = ['improve-factory', 'harness-release'].flatMap((name) =>
  [`.ai/cezar/workflows/${name}.yaml`, `.ai/cezar/workflows/${name}.yml`]);
const PROTECTED_SKILL = 'skills/improve-factory/';

export function isProtectedPath(path: string): boolean {
  const normal = path.replace(/^\.?\//, '');
  return PROTECTED_DIRS.some((dir) => normal.startsWith(dir)) ||
    PROTECTED_WORKFLOWS.includes(normal) ||
    normal.startsWith(PROTECTED_SKILL) || normal.includes(`/${PROTECTED_SKILL}`);
}

/** The changed paths, old names included, that touch an owner-protected path. */
export function protectedChanges(files: readonly { path: string; previousPath?: string }[]): string[] {
  const hits = new Set<string>();
  for (const file of files) {
    for (const path of [file.path, file.previousPath]) if (path && isProtectedPath(path)) hits.add(path);
  }
  return [...hits];
}

/** Whether the project already holds anything protected: an unreadable file list is then held for the owner. */
export function hasProtectedPaths(root: string): boolean {
  return [...PROTECTED_DIRS, ...PROTECTED_WORKFLOWS].some((path) => existsSync(join(root, path))) ||
    ['.ai/skills/improve-factory', '.ai/cezar/skills/improve-factory', 'packages/cezar/skills/improve-factory']
      .some((path) => existsSync(join(root, path)));
}
