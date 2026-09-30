const FRONT = /^---\n([\s\S]*?)\n---\n/;

function yamlValue(value: string): string {
  return /^[\w./@+-][\w ./@+:-]*$/.test(value) && !/:\s|\s#/.test(value) ? value : JSON.stringify(value);
}

/**
 * Set top-level scalar fields in a page's frontmatter. An existing `key:` line is replaced,
 * a missing one is appended at the end of the block, and every other byte stays as it was.
 * A page without frontmatter gets a new block.
 */
export function setFrontmatterFields(text: string, fields: Readonly<Record<string, string>>): string {
  const match = FRONT.exec(text);
  if (match?.[1] === undefined) {
    const lines = Object.entries(fields).map(([key, value]) => `${key}: ${yamlValue(value)}`);
    return `---\n${lines.join('\n')}\n---\n${text}`;
  }
  const lines = match[1].split('\n');
  for (const [key, value] of Object.entries(fields)) {
    const line = `${key}: ${yamlValue(value)}`;
    const index = lines.findIndex((item) => item.startsWith(`${key}:`));
    if (index >= 0) lines[index] = line;
    else lines.push(line);
  }
  return `---\n${lines.join('\n')}\n---\n${text.slice(match[0].length)}`;
}
