import type { RunRecord } from '../runs/store.ts';
import { readFileAtCommit } from '../server/git.ts';

const MAX_SPEC_CONTEXT = 12_000;

function selectedSections(document: string, decisions: ReadonlySet<string>): string[] {
  const headings = [...document.matchAll(/^(#{1,6})[ \t]+(?:([dD][0-9]+)\b)?[^\r\n]*/gm)];
  return headings.flatMap((heading, index) => {
    const [, level, decision] = heading;
    if (!decision || !decisions.has(decision.toUpperCase())) return [];
    const next = headings.slice(index + 1).find((candidate) => candidate[1]!.length <= level!.length);
    return [document.slice(heading.index, next?.index).trimEnd()];
  });
}

/** Only explicitly paired spec paths and decisions from the original brief. */
export async function referencedSpecContext(root: string, run: Pick<RunRecord, 'task' | 'startCommit'>): Promise<string | undefined> {
  if (!run.startCommit) return undefined;

  const references = new Map<string, Set<string>>();
  for (const line of run.task.split('\n')) {
    const paths = [...line.matchAll(/(?<![\w/.-])\.ai\/specs\/[a-z0-9_-]+\.md\b/gi)];
    for (const [index, match] of paths.entries()) {
      const path = match[0];
      const decisions = references.get(path) ?? new Set();
      const scope = line.slice(match.index + path.length, paths[index + 1]?.index);
      for (const id of scope.matchAll(/\bD[0-9]+\b/gi)) decisions.add(id[0].toUpperCase());
      if (decisions.size) references.set(path, decisions);
    }
  }

  let context = '';
  for (const [path, decisions] of [...references].slice(0, 4)) {
    const document = await readFileAtCommit(root, run.startCommit, path);
    if (!document) continue;
    const sections = selectedSections(document, decisions);
    if (sections.length) context += path + '\n' + sections.join('\n\n') + '\n\n';
    if (context.length >= MAX_SPEC_CONTEXT) return context.slice(0, MAX_SPEC_CONTEXT);
  }
  return context.trim() || undefined;
}
