/**
 * Text replacement for the search view.
 *
 * The backend search command is fixed-string only and has no replace, so replace
 * is performed here over the existing read/write commands. Those carry a hash
 * check, which means a file changed by the Agent mid-replace is rejected rather
 * than clobbered.
 */

export interface ReplacePlanEntry {
  path: string;
  /** Number of occurrences that would change in this file. */
  count: number;
}

/** Count non-overlapping occurrences of a literal needle. */
export function countOccurrences(content: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = content.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = content.indexOf(needle, index + needle.length);
  }
  return count;
}

/** Replace every literal occurrence, returning the new text and how many changed. */
export function replaceAll(
  content: string,
  needle: string,
  replacement: string,
): { content: string; count: number } {
  if (!needle) return { content, count: 0 };
  const count = countOccurrences(content, needle);
  if (count === 0) return { content, count: 0 };
  return { content: content.split(needle).join(replacement), count };
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
): string | null {
  if (!needle) return null;
  const lines = content.split("\n");
  const index = line - 1;
  if (index < 0 || index >= lines.length) return null;
  if (!lines[index].includes(needle)) return null;
  lines[index] = lines[index].replace(needle, replacement);
  return lines.join("\n");
}

/** Summarise a replace run for a confirmation prompt. */
export function describeReplacePlan(entries: ReplacePlanEntry[]): string {
  const files = entries.filter((entry) => entry.count > 0);
  const total = files.reduce((sum, entry) => sum + entry.count, 0);
  if (total === 0) return "没有可替换的匹配项";
  return `将在 ${files.length} 个文件中替换 ${total} 处匹配`;
}
