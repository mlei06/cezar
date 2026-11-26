export function splitMarkdownFrontmatter(raw: string): { block: string; body: string } | undefined {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const match = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
  return match ? { block: match[1] ?? '', body: text.slice(match[0].length) } : undefined;
}
