import { buildCodingWorkflowPrompt } from "@/features/coding/lib/workflow";

/**
 * AI action prompt builders used by the right-click AI submenu. Each builder
 * produces a self-contained `requirement` string that gets handed to
 * `buildCodingWorkflowPrompt` (or returned as-is) before being sent to the
 * Agent via `onStartRun`.
 */

export interface DocumentSnippet {
  /** Absolute path inside the workspace. */
  path: string;
  /** Hash returned by `codingReadDocument`; used for dedupe + audit. */
  hash: string;
  /** Pre-read file content. */
  content: string;
}

const REVIEW_MAX_CHARS_PER_FILE = 8000;

/** Truncate a file body so a single huge file doesn't blow the prompt budget. */
export function truncateForReview(content: string): string {
  if (content.length <= REVIEW_MAX_CHARS_PER_FILE) return content;
  const remaining = content.length - REVIEW_MAX_CHARS_PER_FILE;
  return `${content.slice(0, REVIEW_MAX_CHARS_PER_FILE)}\n\n…（后续省略 ${remaining} 字符）`;
}

/**
 * Build a review prompt. Embeds the full content of every selected file (with
 * per-file truncation) so the Agent can audit cross-file issues without
 * having to issue `read_file` calls first.
 */
export function buildReviewPrompt(docs: DocumentSnippet[]): string {
  const fileBlocks = docs
    .map(
      (doc) =>
        `### ${doc.path}\n\n\`\`\`\n${truncateForReview(doc.content)}\n\`\`\``,
    )
    .join("\n\n");
  return `[代码评审请求]

请对以下 ${docs.length} 个文件做一次专业代码评审，重点关注：
1. 正确性：是否有可观察的 bug、空指针、边界条件遗漏
2. 可维护性：命名、职责单一、是否过度耦合
3. 性能：明显的复杂度问题（N²、可避免的分配）
4. 安全性：注入、未捕获异常、敏感数据泄露
5. 一致性：是否与相邻模块风格一致

按"严重 / 建议 / 风格"三档输出，**只列问题**，不修改代码。如果无问题请明说。

${fileBlocks}

---

评审输出格式：

- [严重] <文件>:<行号或函数> — <一句话描述> — 建议
- [建议] …
- [风格] …`;
}

/**
 * Refactor suggestion prompt. Does NOT pre-read content; the Agent is left
 * to walk the files on its own so the result is concise.
 */
export function buildRefactorPrompt(paths: string[], userNote: string): string {
  const noteSection = userNote.trim()
    ? `\n用户关注点：\n${userNote.trim()}\n`
    : "";
  const requirement =
    `对 ${paths.join(", ")} 提出**仅建议**的重构方案。${noteSection}\n` +
    `严格要求：\n` +
    `1. 只阅读不修改，先用 Plan 工具列出所有发现的问题点与建议\n` +
    `2. 按问题严重性排序，每个建议给出"目标 / 现状 / 推荐改法 / 验证方法"\n` +
    `3. 不写实现代码，只给重构方向\n`;
  return buildCodingWorkflowPrompt(requirement, paths);
}

/**
 * Test-generation prompt. The detected framework string is injected verbatim
 * so the Agent can pick the right test runner; callers should default to a
 * reasonable guess ("vitest" / "jest" / "pytest") rather than leaving the
 * choice ambiguous.
 */
export function buildTestsPrompt(
  paths: string[],
  framework: string | null,
  userNote: string,
): string {
  const fw = framework ?? "自动推断（vitest/jest/pytest）";
  const note = userNote.trim() ? `\n覆盖要求：\n${userNote.trim()}\n` : "";
  const requirement =
    `为 ${paths.join(", ")} 生成 ${fw} 测试。${note}\n` +
    `要求：\n` +
    `1. 先 RED：先写能失败的测试覆盖核心路径\n` +
    `2. 再实现最小代码让测试通过\n` +
    `3. 覆盖 happy path + 主要错误路径 + 边界条件\n`;
  return buildCodingWorkflowPrompt(requirement, paths);
}
