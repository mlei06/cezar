import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { managersDir } from '../paths.ts';

/**
 * Skills only managers see. Task agents read the machine's global skill folders, so a manager's
 * playbook kept there leaks into every task (one loaded it because its description matched the
 * task's job). These live in cezar's own `manager-skills/` (bundled) and `~/.cezar/manager-skills/`
 * (the user's, winning on a shared name), and are linked into each manager's working folder,
 * where Claude Code (`.claude/skills`) and Codex/OpenCode (`.agents/skills`) look.
 */
export const BUNDLED_MANAGER_SKILLS_DIR = fileURLToPath(new URL('../../manager-skills/', import.meta.url));
export const userManagerSkillsDir = (): string => join(managersDir(), '..', 'manager-skills');

const TARGETS = ['.claude/skills', '.agents/skills'] as const;

/** Name → directory, user skills over bundled ones. @internal */
export function managerSkillSources(dirs: readonly string[] = [BUNDLED_MANAGER_SKILLS_DIR, userManagerSkillsDir()]): Map<string, string> {
  const found = new Map<string, string>();
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const skill = join(dir, name);
      if (existsSync(join(skill, 'SKILL.md'))) found.set(name, resolve(skill));
    }
  }
  return found;
}

/** Link every manager skill into `workdir`, replacing links cezar made that no longer match. */
export function provisionManagerSkills(workdir: string, sources: Map<string, string> = managerSkillSources()): string[] {
  const linked: string[] = [];
  for (const target of TARGETS) {
    const dir = join(workdir, target);
    mkdirSync(dir, { recursive: true });
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      try {
        if (!lstatSync(path).isSymbolicLink()) continue;
        const to = resolve(dir, readlinkSync(path));
        // Only a link into a manager-skills folder is ours to replace or drop.
        if (/manager-skills/.test(to) && sources.get(name) !== to) rmSync(path, { force: true });
      } catch {
        // gone meanwhile
      }
    }
    for (const [name, source] of sources) {
      const path = join(dir, name);
      if (existsSync(path)) continue;
      try {
        symlinkSync(source, path, process.platform === 'win32' ? 'junction' : 'dir');
        linked.push(`${target}/${name}`);
      } catch {
        // a read-only workdir: the turn still runs without it
      }
    }
  }
  return linked;
}
