/**
 * Unified diff 算法 — 有界的行级 diff。
 *
 * 替代 ToolCallCard 中的朴素逐行对比。对齐 EchoAgent 的
 * `multi-edit-diff-viewer.tsx` 和 `diff-viewer.tsx`。
 *
 * 纯函数,无副作用,便于单测。
 */

export type DiffLineKind = "add" | "del" | "context";

export interface DiffLine {
  kind: DiffLineKind;
  /** 旧文件行号 (1-based), 删除/上下文行有值 */
  oldLine?: number;
  /** 新文件行号 (1-based), 添加/上下文行有值 */
  newLine?: number;
  /** 行内容 */
  text: string;
}

export interface UnifiedDiffResult {
  lines: DiffLine[];
  /** 统计 */
  added: number;
  removed: number;
  context: number;
  /** 文件路径(若有) */
  path?: string;
}

// A full LCS table is quadratic. Keep the exact algorithm for normal edits,
// then use a linear, prefix/suffix-preserving fallback for unusually large
// tool output. The rendered result is capped as a second line of defence so a
// hostile MCP response cannot freeze the WebView with tens of thousands of
// DOM nodes.
const MAX_LCS_CELLS = 1_000_000;
const MAX_RENDERED_DIFF_LINES = 4_000;

function capRenderedLines(lines: DiffLine[]): DiffLine[] {
  if (lines.length <= MAX_RENDERED_DIFF_LINES) return lines;
  const headCount = Math.floor(MAX_RENDERED_DIFF_LINES / 2);
  const tailCount = MAX_RENDERED_DIFF_LINES - headCount;
  const omitted = lines.length - headCount - tailCount;
  return [
    ...lines.slice(0, headCount),
    { kind: "context", text: `… 已省略 ${omitted} 行以保持界面流畅 …` },
    ...lines.slice(-tailCount),
  ];
}

function filterContext(lines: DiffLine[], contextLines: number): DiffLine[] {
  if (lines.every((line) => line.kind === "context")) return capRenderedLines(lines);
  const kept = new Array(lines.length).fill(false);
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].kind === "context") continue;
    for (
      let cursor = Math.max(0, index - contextLines);
      cursor <= Math.min(lines.length - 1, index + contextLines);
      cursor++
    ) {
      kept[cursor] = true;
    }
  }
  return capRenderedLines(lines.filter((_, index) => kept[index]));
}

/**
 * 计算两组文本行的 diff。常规编辑使用精确 LCS；超大输入使用
 * 线性回退，避免二次方内存/时间导致桌面端卡死。
 * 返回带 +/-/context 标记的行列表。
 *
 * @param oldText 旧文本
 * @param newText 新文本
 * @param contextLines 上下文行数(默认 3)
 */
export function computeUnifiedDiff(
  oldText: string,
  newText: string,
  contextLines = 3,
): DiffLine[] {
  // 空文本特殊处理
  const oldLines = oldText ? oldText.split("\n") : [];
  const newLines = newText ? newText.split("\n") : [];

  const n = oldLines.length;
  const m = newLines.length;

  // 完全空 → 无 diff
  if (n === 0 && m === 0) return [];

  let prefix = 0;
  while (prefix < n && prefix < m && oldLines[prefix] === newLines[prefix]) prefix++;
  let oldEnd = n;
  let newEnd = m;
  while (
    oldEnd > prefix
    && newEnd > prefix
    && oldLines[oldEnd - 1] === newLines[newEnd - 1]
  ) {
    oldEnd--;
    newEnd--;
  }

  const lines: DiffLine[] = [];
  for (let index = 0; index < prefix; index++) {
    lines.push({ kind: "context", oldLine: index + 1, newLine: index + 1, text: oldLines[index] });
  }

  const oldMiddle = oldLines.slice(prefix, oldEnd);
  const newMiddle = newLines.slice(prefix, newEnd);
  if (oldMiddle.length * newMiddle.length <= MAX_LCS_CELLS) {
    const dp: number[][] = [];
    for (let row = 0; row <= oldMiddle.length; row++) {
      dp.push(new Array(newMiddle.length + 1).fill(0));
    }
    for (let row = 1; row <= oldMiddle.length; row++) {
      for (let column = 1; column <= newMiddle.length; column++) {
        dp[row][column] = oldMiddle[row - 1] === newMiddle[column - 1]
          ? dp[row - 1][column - 1] + 1
          : Math.max(dp[row - 1][column], dp[row][column - 1]);
      }
    }

    let row = oldMiddle.length;
    let column = newMiddle.length;
    const middle: DiffLine[] = [];
    while (row > 0 || column > 0) {
      if (row > 0 && column > 0 && oldMiddle[row - 1] === newMiddle[column - 1]) {
        middle.push({
          kind: "context",
          oldLine: prefix + row,
          newLine: prefix + column,
          text: oldMiddle[row - 1],
        });
        row--;
        column--;
      } else if (
        column > 0
        && (row === 0 || dp[row][column - 1] >= dp[row - 1][column])
      ) {
        middle.push({ kind: "add", newLine: prefix + column, text: newMiddle[column - 1] });
        column--;
      } else {
        middle.push({ kind: "del", oldLine: prefix + row, text: oldMiddle[row - 1] });
        row--;
      }
    }
    middle.reverse();
    lines.push(...middle);
  } else {
    // Bounded coarse fallback. Common prefix/suffix and exact line numbers are
    // still preserved; only move detection inside a huge changed region is
    // intentionally sacrificed.
    for (let index = prefix; index < oldEnd; index++) {
      lines.push({ kind: "del", oldLine: index + 1, text: oldLines[index] });
    }
    for (let index = prefix; index < newEnd; index++) {
      lines.push({ kind: "add", newLine: index + 1, text: newLines[index] });
    }
  }

  for (let oldIndex = oldEnd, newIndex = newEnd; oldIndex < n && newIndex < m; oldIndex++, newIndex++) {
    lines.push({
      kind: "context",
      oldLine: oldIndex + 1,
      newLine: newIndex + 1,
      text: oldLines[oldIndex],
    });
  }
  return filterContext(lines, Math.max(0, Math.min(contextLines, 100)));
}

/** 统计 diff 结果 */
export function summarizeDiff(lines: DiffLine[]): { added: number; removed: number; context: number } {
  let added = 0, removed = 0, context = 0;
  for (const l of lines) {
    if (l.kind === "add") added++;
    else if (l.kind === "del") removed++;
    else context++;
  }
  return { added, removed, context };
}

/** 将 hunks 格式(DiffContent.diff.hunks)转为 unified diff lines */
export function hunksToUnifiedLines(
  hunks: Array<{
    old: { start: number; lines: string[] };
    new: { start: number; lines: string[] };
  }>,
): DiffLine[] {
  const result: DiffLine[] = [];
  for (const h of hunks) {
    // Old lines (deletions)
    for (let i = 0; i < h.old.lines.length; i++) {
      result.push({ kind: "del", oldLine: h.old.start + i, text: h.old.lines[i] });
    }
    // New lines (additions)
    for (let i = 0; i < h.new.lines.length; i++) {
      result.push({ kind: "add", newLine: h.new.start + i, text: h.new.lines[i] });
    }
  }
  return capRenderedLines(result);
}
