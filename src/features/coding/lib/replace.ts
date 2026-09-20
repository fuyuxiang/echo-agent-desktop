/**
 * Text replacement for the search view.
 *
 * The backend search command and this replacement helper share literal/regex,
 * case and whole-word options. Replacement is performed over hash-checked
 * document writes, so a file changed by the Agent mid-replace is rejected
 * rather than clobbered.
 */

export interface ReplacePlanEntry {
  path: string;
  /** Number of occurrences that would change in this file. */
  count: number;
}

/** Count non-overlapping occurrences under the active search contract. */
function literalPattern(
  needle: string,
  caseSensitive: boolean,
  regex = false,
  wholeWord = false,
): RegExp {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const source = regex ? needle : escaped;
  return new RegExp(wholeWord ? `\\b(?:${source})\\b` : source, caseSensitive ? "gu" : "giu");
}

export function countOccurrences(
  content: string,
  needle: string,
  caseSensitive = true,
  regex = false,
  wholeWord = false,
): number {
  if (!needle) return 0;
  return [...content.matchAll(literalPattern(needle, caseSensitive, regex, wholeWord))].length;
}

/** Replace every occurrence, returning the new text and how many changed. */
export function replaceAll(
  content: string,
  needle: string,
  replacement: string,
  caseSensitive = true,
  regex = false,
  wholeWord = false,
): { content: string; count: number } {
  if (!needle) return { content, count: 0 };
  const pattern = literalPattern(needle, caseSensitive, regex, wholeWord);
  const count = [...content.matchAll(pattern)].length;
  if (count === 0) return { content, count: 0 };
  return {
    content: regex
      ? content.replace(pattern, replacement)
      : content.replace(pattern, () => replacement),
    count,
  };
}

/**
 * Replace one occurrence at a known line, used for per-hit replacement.
 *
 * `line` is 1-based to match search results. Returns `null` when the line does
 * not contain the needle any more, which happens if the file changed after the
 * search ran — the caller must treat that as a stale hit rather than guessing.
 */
export function replaceAtLine(
  content: string,
  line: number,
  needle: string,
  replacement: string,
  caseSensitive = true,
): string | null {
  if (!needle) return null;
  const lines = content.split("\n");
  const index = line - 1;
  if (index < 0 || index >= lines.length) return null;
  const pattern = literalPattern(needle, caseSensitive);
  pattern.lastIndex = 0;
  if (!pattern.test(lines[index])) return null;
  pattern.lastIndex = 0;
  lines[index] = lines[index].replace(pattern, () => replacement);
  return lines.join("\n");
}

/** Summarise a replace run for a confirmation prompt. */
export function describeReplacePlan(entries: ReplacePlanEntry[]): string {
  const files = entries.filter((entry) => entry.count > 0);
  const total = files.reduce((sum, entry) => sum + entry.count, 0);
  if (total === 0) return "没有可替换的匹配项";
  return `将在 ${files.length} 个文件中替换 ${total} 处匹配`;
}
