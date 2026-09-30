import type { Target } from '../ledger/ledger.types.js';
import { addHistory } from './history.js';

const LEADING_LINK = /^- \[[^\]]*\]\([^)]*\)/;

/**
 * Apply a correction an agent filed: the first occurrence of the claimed text in the live part of
 * the file — never in History, which records what was once said — becomes the truth, and a History
 * line records who said so. For an index line only the text after the line's link changes, on the
 * line that links the file. A claim that is not there verbatim is never applied fuzzily: undefined.
 */
export function applyCorrection(text: string, target: Target, claimed: string, truth: string,
  evidence: readonly string[], date: string): string | undefined {
  if (claimed.trim().length < 3) return undefined;
  if (target.kind === 'index_line') {
    const file = target.id.split(':').slice(2).join(':');
    const lines = text.split('\n');
    const tail = (line: string): string => line.slice(LEADING_LINK.exec(line)?.[0].length ?? 0);
    const index = lines.findIndex((line) => line.includes(`](${file})`) && tail(line).includes(claimed));
    if (index < 0) return undefined;
    const line = lines[index] ?? '';
    const head = line.slice(0, line.length - tail(line).length);
    lines[index] = `${head}${tail(line).replace(claimed, () => truth)}`;
    return lines.join('\n');
  }
  const history = text.search(/\n## History\n/);
  const at = (history < 0 ? text : text.slice(0, history)).indexOf(claimed);
  if (at < 0) return undefined;
  const replaced = `${text.slice(0, at)}${truth}${text.slice(at + claimed.length)}`;
  return addHistory(replaced, `- ${date}: corrected "${claimed}" → "${truth}"${evidence.length ? ` (${evidence.join(', ')})` : ''}`);
}
