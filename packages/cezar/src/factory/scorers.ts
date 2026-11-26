import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { scorerMetadataSchema, scorerNameSchema, type ScorerMetadata } from '@open-mercato/cezar-contract';
import { splitMarkdownFrontmatter } from '../markdown-frontmatter.ts';

export const SCORERS_DIR = '.ai/cezar/scorers';
const bundled = join(import.meta.dirname, 'scorers');
// tsx development opens the same owner-maintained files that copy-assets puts in dist.
const builtinRoot = existsSync(bundled) ? bundled : join(import.meta.dirname, '../../../..', SCORERS_DIR);

export type Scorer = ScorerMetadata & {
  name: string;
  rubric: string;
  source: 'builtin' | 'project';
};

export interface ScorerIssue {
  path: string;
  message: string;
}

export function parseScorer(name: string, markdown: string, source: Scorer['source']): Scorer {
  const parts = splitMarkdownFrontmatter(markdown);
  if (!parts?.body.trim()) throw new Error('Expected YAML frontmatter followed by a rubric.');
  let metadata: unknown;
  try {
    metadata = parse(parts.block);
  } catch {
    throw new Error('Invalid scorer YAML frontmatter.');
  }
  const validated = scorerMetadataSchema.safeParse(metadata);
  if (!validated.success) throw new Error(validated.error.issues.map((issue) => issue.message).join(' '));
  return { name: scorerNameSchema.parse(name), ...validated.data, rubric: parts.body, source };
}

/** Keep the most recently valid definition for an invalid file until it is repaired or removed. */
export class ScorerCatalog {
  private readonly lastValid = new Map<string, Map<string, Scorer>>();

  async load(repoRoot: string, workflowNames: ReadonlySet<string>): Promise<{ scorers: Scorer[]; issues: ScorerIssue[] }> {
    const scorers = new Map<string, Scorer>();
    const issues: ScorerIssue[] = [];
    const projectScorers = this.lastValid.get(repoRoot) ?? new Map<string, Scorer>();
    this.lastValid.set(repoRoot, projectScorers);
    const loadRoot = async (dir: string, source: Scorer['source']) => {
      const found = new Set<string>();
      const entries = await readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' && source === 'project') return [];
        issues.push({ path: dir, message: 'Cannot read scorer directory.' });
        if (source === 'project') {
          for (const [name, scorer] of projectScorers) {
            scorers.set(name, scorer);
            found.add(name);
          }
        }
        return [];
      });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const path = join(dir, entry.name, 'scorer.md');
        try {
          const scorer = parseScorer(entry.name, await readFile(path, 'utf8'), source);
          const missing = scorer.workflows?.filter((name) => !workflowNames.has(name));
          if (missing?.length) throw new Error(`Unknown workflows: ${missing.join(', ')}.`);
          scorers.set(entry.name, scorer);
          found.add(entry.name);
          if (source === 'project') projectScorers.set(entry.name, scorer);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          issues.push({ path, message: error instanceof Error ? error.message : String(error) });
          found.add(entry.name);
          const previous = projectScorers.get(entry.name);
          if (source === 'project' && previous) scorers.set(entry.name, previous);
        }
      }
      return found;
    };
    await loadRoot(builtinRoot, 'builtin');
    const installed = await loadRoot(join(repoRoot, SCORERS_DIR), 'project');
    for (const name of projectScorers.keys()) if (!installed.has(name)) projectScorers.delete(name);
    return { scorers: [...scorers.values()].sort((a, b) => a.name.localeCompare(b.name)), issues };
  }
}
