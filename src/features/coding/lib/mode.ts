import type { CodingMode } from "./types";

export interface CodingModeOption {
  id: CodingMode;
  label: "Ask" | "Plan" | "Agent";
  description: string;
  placeholder: string;
  submitLabel: string;
}

export const CODING_MODE_OPTIONS: CodingModeOption[] = [
  {
    id: "ask",
    label: "Ask",
    description: "只读搜索、分析和回答，不修改工程文件",
    placeholder: "询问代码库，例如：为什么登录接口偶尔返回 500？",
    submitLabel: "开始只读分析",
  },
  {
    id: "plan",
    label: "Plan",
    description: "先研究工程并生成可审阅计划，批准后再实施",
    placeholder: "描述需要规划的改动，例如：设计登录模块的 OIDC 迁移方案…",
    submitLabel: "生成实施计划",
  },
  {
    id: "agent",
    label: "Agent",
    description: "自主修改代码、运行检查并验证结果",
    placeholder: "描述要完成的任务，不用预先区分功能、修复或测试…",
    submitLabel: "开始 Agent 任务",
  },
];

export function codingModeOption(mode: CodingMode): CodingModeOption {
  return CODING_MODE_OPTIONS.find((entry) => entry.id === mode) ?? CODING_MODE_OPTIONS[2];
}

/**
 * Build the hidden runtime contract while keeping the user's transcript clean.
 * Reused for the first turn and follow-ups so a read-only Ask cannot silently
 * drift into implementation later in the conversation.
 */
export function buildCodingModePrompt(
  mode: CodingMode,
  request: string,
  contextPaths: string[] = [],
  followup = false,
): string {
  const modeInstruction = mode === "ask"
    ? [
        `[Echo Code 工作模式：Ask / 只读${followup ? "追问" : ""}]`,
        "仅可搜索、阅读和分析当前工程，直接回答用户的问题。",
        "禁止修改、创建或删除文件，禁止运行可能改变工作区、依赖或外部状态的命令。",
        "不要提交实施计划或请求开始实施；调研完成后立即给出结论、证据和建议。",
      ].join("\n")
    : mode === "plan"
      ? [
          "[Echo Code 工作模式：Plan]",
          "先只读研究代码库、确认影响范围和验证方法，然后提交可审阅的实施计划。",
          "在用户批准之前不得修改文件或执行会改变工程状态的操作。",
        ].join("\n")
      : [
          "[Echo Code 工作模式：Agent]",
          "请直接完成任务：分析影响、修改代码、补充必要测试，并运行与改动相匹配的验证。",
        ].join("\n");

  const normalizedContext = [...new Set(contextPaths.map((path) => path.trim()).filter(Boolean))];
  const contextInstruction = normalizedContext.length > 0
    ? `\n\n用户指定的优先工程上下文（请先阅读并按需追踪依赖）：\n${normalizedContext.map((path) => `- ${path}`).join("\n")}`
    : "";
  return `${modeInstruction}\n\n${followup ? "用户追问" : "用户请求"}：\n${request.trim()}${contextInstruction}`;
}
