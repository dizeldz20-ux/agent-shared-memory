const FRONT = /^---\n[\s\S]*?\n---\n/;

/** The text after the frontmatter. */
export const bodyOf = (text: string): string => text.replace(FRONT, '');

/** Every non-empty line of the original body appears as a line of the output. */
export function everyLineKept(original: string, output: string): boolean {
  const lines = new Set(output.split('\n').map((line) => line.trim()));
  return original.replace(FRONT, '').split('\n').map((line) => line.trim()).filter(Boolean).every((line) => lines.has(line));
}

/** A memory file that already has a Current state section (compacted, or written that way). */
export const hasCurrentState = (text: string): boolean => /^## Current state\b/m.test(bodyOf(text));

/**
 * A memory file that became a log gets its current state on top — dated, so a reader can tell its
 * age — and its whole original body, verbatim, under History. Nothing is dropped: the result is
 * rejected unless every line survives. A file that already has a Current state is not compacted again.
 */
export function compact(text: string, currentState: string, asOf: string): string | undefined {
  const front = FRONT.exec(text)?.[0] ?? '';
  const body = text.slice(front.length);
  if (hasCurrentState(text) || !currentState.trim()) return undefined;
  const out = `${front}\n## Current state (as of ${asOf})\n\n${currentState.trim()}\n\n## History\n\n${body.trim()}\n`;
  return everyLineKept(text, out) ? out : undefined;
}
