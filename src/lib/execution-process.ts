import type { MessagePart, ToolCallView } from "@/stores/session-store";
import { detectToolRenderer } from "@/lib/tool-renderers";

export type TextMessagePart = Extract<MessagePart, { kind: "text" }>;

export interface AssistantPartGroups {
  /** Reasoning, tool calls, and any preamble text before the final answer. */
  processParts: MessagePart[];
  /** Text that belongs to the user-facing final answer. */
  responseParts: TextMessagePart[];
}

/**
 * Split one assistant turn into a compact execution process and its final answer.
 *
 * ACP streams preambles, reasoning and tools into one ordered parts array. The
 * last run of text after the last process event is the final answer. If a turn
 * ends without trailing text, keep all text visible as the answer so an unusual
 * provider ordering can never hide user-facing content inside a collapsed card.
 */
export function partitionAssistantParts(parts: MessagePart[]): AssistantPartGroups {
  let lastProcessIndex = -1;
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index].kind !== "text") lastProcessIndex = index;
  }

  if (lastProcessIndex === -1) {
    return {
      processParts: [],
      responseParts: parts.filter(isTextPart),
    };
  }

  const trailingResponse = parts.slice(lastProcessIndex + 1).filter(isTextPart);
  if (trailingResponse.some((part) => part.text.trim().length > 0)) {
    return {
      processParts: parts.slice(0, lastProcessIndex + 1),
      responseParts: trailingResponse,
    };
  }

  return {
    processParts: parts.filter((part) => part.kind !== "text"),
    responseParts: parts.filter(isTextPart),
  };
}

export interface ExecutionProcessSummary {
  state: "running" | "complete" | "attention" | "stopped";
  title: string;
  toolCount: number;
  completedToolCount: number;
  failedToolCount: number;
  thoughtCount: number;
  changedFiles: string[];
}

/** Build the short, semantic status shown in the process header. */
export function summarizeExecutionProcess(
  parts: MessagePart[],
  active: boolean,
  stopReason?: string,
): ExecutionProcessSummary {
  const tools = parts
    .filter((part): part is Extract<MessagePart, { kind: "tool_call" }> => part.kind === "tool_call")
    .map((part) => part.toolCall);
  const thoughts = parts.filter((part) => part.kind === "thought");
  const failedToolCount = tools.filter((tool) => tool.status === "failed").length;
  const completedToolCount = tools.filter((tool) => tool.status === "completed").length;
  const currentTool = [...tools].reverse().find((tool) => tool.status === "in_progress");
  const changedFiles = [...new Set(tools.flatMap(toolDiffPaths))];

  const abnormalStop = ["error", "rate_limit", "rate_limited"].includes(stopReason ?? "");
  const state = !active && stopReason === "cancelled"
    ? "stopped"
    : failedToolCount > 0 || (!active && abnormalStop)
      ? "attention"
    : active
      ? "running"
      : "complete";

  let title: string;
  if (state === "stopped") {
    title = "已停止执行";
  } else if (state === "attention") {
    title = active
      ? "执行遇到问题，正在继续处理"
      : abnormalStop
        ? "执行未正常完成"
        : "执行过程有失败项";
  } else if (active) {
    title = currentTool ? activeToolLabel(currentTool) : "正在分析任务";
  } else if (tools.length > 0) {
    title = "已完成执行过程";
  } else {
    title = "已完成思考";
  }

  return {
    state,
    title,
    toolCount: tools.length,
    completedToolCount,
    failedToolCount,
    thoughtCount: thoughts.length,
    changedFiles,
  };
}

export function formatProcessDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  if (minutes < 60) return remaining > 0 ? `${minutes}分${remaining}秒` : `${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}小时${remainingMinutes}分` : `${hours}小时`;
}

function isTextPart(part: MessagePart): part is TextMessagePart {
  return part.kind === "text";
}

function toolDiffPaths(tool: ToolCallView): string[] {
  return (tool.content ?? []).flatMap((content) =>
    content.type === "diff" && content.diff.path ? [content.diff.path] : [],
  );
}

function activeToolLabel(tool: ToolCallView): string {
  switch (detectToolRenderer(tool.kind)) {
    case "command":
      return "正在运行命令";
    case "edit":
      return "正在修改文件";
    case "read":
      return "正在读取项目文件";
    case "search":
      return "正在检索资料";
    case "task":
      return "子代理正在处理";
    case "defer-execute":
      return "正在准备批量操作";
    case "send-message":
    case "agent-mail":
      return "正在发送消息";
    case "image-gen":
      return "正在生成图像";
    case "visualizer":
      return "正在生成可视化";
    case "team-create":
    case "team-delete":
    case "team-status":
      return "正在协调团队";
    case "specialist":
      return "正在查找专家";
    case "knowledge":
      return "正在检索组织知识";
    default:
      return "正在执行操作";
  }
}
