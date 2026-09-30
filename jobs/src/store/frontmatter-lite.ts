const FRONT = /^---\n([\s\S]*?)\n---\n/;

/** Top-level scalar `key: value` pairs of a page's YAML frontmatter; lists and nesting are ignored. */
export function frontmatterScalars(text: string): Record<string, string> {
  const block = FRONT.exec(text)?.[1] ?? '';
  const out: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const match = /^([A-Za-z_][\w-]*):[ \t]*(.*?)[ \t]*$/.exec(line);
    if (!match?.[1] || match[2] === undefined || match[2].startsWith('[')) continue;
    out[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

/** The first characters of a page's body, after its frontmatter. */
export function bodyHead(text: string, length = 1500): string {
  return text.replace(FRONT, '').slice(0, length);
}
