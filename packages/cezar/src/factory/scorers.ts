import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { scorerMetadataSchema, scorerNameSchema, type ScorerMetadata } from '@open-mercato/cezar-contract';
import { splitMarkdownFrontmatter } from '../markdown-frontmatter.ts';
import { cezarHomeDir } from '../paths.ts';
import { atomicWriteJson, serializedByPath } from '../workspace/config.ts';

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
  private readonly lastValid = new Map<string, Map<string, string>>();

  constructor(private readonly persist = false) {}

  async load(repoRoot: string, workflowNames: ReadonlySet<string>): Promise<{ scorers: Scorer[]; issues: ScorerIssue[] }> {
    const projectKey = createHash('sha256').update(repoRoot).digest('hex');
    const path = join(cezarHomeDir(), 'factory', 'scorer-cache', projectKey + '.json');
    return serializedByPath(path, async () => {
      const projectScorers = this.lastValid.get(repoRoot) ?? (this.persist ? await this.readCache(path) : new Map());
      const existing = JSON.stringify([...projectScorers]);
      const result = await this.loadDefinitions(repoRoot, workflowNames, projectScorers);
      this.lastValid.set(repoRoot, projectScorers);
      if (this.persist && existing !== JSON.stringify([...projectScorers])) {
        await atomicWriteJson(path, [...projectScorers]).catch(() => undefined);
      }
      return result;
    });
  }

  private async readCache(path: string): Promise<Map<string, string>> {
    try {
      const content: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (!Array.isArray(content)) return new Map();
      const defs = new Map<string, string>();
      for (const entry of content) {
        if (!Array.isArray(entry) || entry.length !== 2) continue;
        const [name, markdown] = entry as [unknown, unknown];
        if (typeof name !== 'string' || typeof markdown !== 'string') continue;
        try {
          parseScorer(name, markdown, 'project');
          defs.set(name, markdown);
        } catch {
          // Invalid cache entries cannot supply a rubric.
        }
      }
      return defs;
    } catch {
      return new Map();
    }
  }

  private async loadDefinitions(repoRoot: string, workflowNames: ReadonlySet<string>, projectScorers: Map<string, string>) {
    const scorers = new Map<string, Scorer>();
    const issues: ScorerIssue[] = [];
    const loadRoot = async (dir: string, source: Scorer['source']) => {
      const found = new Set<string>();
      const entries = await readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' && source === 'project') return [];
        issues.push({ path: dir, message: 'Cannot read scorer directory.' });
        if (source === 'project') {
          for (const [name, markdown] of projectScorers) {
            scorers.set(name, parseScorer(name, markdown, source));
            found.add(name);
          }
        }
        return [];
      });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const path = join(dir, entry.name, 'scorer.md');
        try {
          const markdown = await readFile(path, 'utf8');
          const scorer = parseScorer(entry.name, markdown, source);
          const missing = scorer.workflows?.filter((name) => !workflowNames.has(name));
          if (missing?.length) throw new Error(`Unknown workflows: ${missing.join(', ')}.`);
          scorers.set(entry.name, scorer);
          found.add(entry.name);
          if (source === 'project') projectScorers.set(entry.name, markdown);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          issues.push({ path, message: error instanceof Error ? error.message : String(error) });
          found.add(entry.name);
          const previous = projectScorers.get(entry.name);
          if (source === 'project' && previous) scorers.set(entry.name, parseScorer(entry.name, previous, source));
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
