/** Add a line under the file's `## History` section, creating the section at the end when absent. */
export function addHistory(text: string, note: string): string {
  if (/\n## History\n/.test(text)) return text.replace(/\n## History\n/, (heading) => `${heading}\n${note}\n`);
  return `${text.trimEnd()}\n\n## History\n\n${note}\n`;
}
