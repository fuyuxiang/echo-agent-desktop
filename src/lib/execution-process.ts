import type { MessagePart, ToolCallView } from "@/stores/session-store";
import { detectToolRenderer } from "@/lib/tool-renderers";

export type TextMessagePart = Extract<MessagePart, { kind: "text" }>;

export interface AssistantPartGroups {
  /** Reasoning and tool calls that may be folded without hiding assistant text. */
  processParts: MessagePart[];
  /** Every user-visible assistant text chunk, in protocol order. */
  responseParts: TextMessagePart[];
}

/**
 * Split one assistant turn into a compact execution process and its final answer.
 *
 * ACP distinguishes assistant text from reasoning, but does not distinguish a
 * textual "preamble" from a "final answer". Reasoning may legally be interleaved
 * between two assistant-text chunks. Therefore positional inference is unsafe:
 * every text part remains visible/copyable/exportable and only explicit process
 * events (thoughts and tools) are folded.
 */
export function partitionAssistantParts(parts: MessagePart[]): AssistantPartGroups {
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
  cancellationCategory?: string,
  cancelTrigger?: string,
): ExecutionProcessSummary {
  const tools = parts
    .filter((part): part is Extract<MessagePart, { kind: "tool_call" }> => part.kind === "tool_call")
    .map((part) => part.toolCall);
  const thoughts = parts.filter((part) => part.kind === "thought");
  const failedToolCount = tools.filter((tool) => tool.status === "failed").length;
  const completedToolCount = tools.filter((tool) => tool.status === "completed").length;
  const unfinishedToolCount = tools.filter((tool) => tool.status === "in_progress").length;
  const currentTool = [...tools].reverse().find((tool) => tool.status === "in_progress");
  const changedFiles = [...new Set(
    tools.filter((tool) => tool.status === "completed").flatMap(toolDiffPaths),
  )];

  const abnormalStop = [
    "error",
    "rate_limit",
    "rate_limited",
    "refusal",
    "content_filter",
    "max_tokens",
    "max_turns",
  ].includes(stopReason ?? "");
  const abnormalCancellation = [
    "HookDenied",
    "max_turns_reached",
    "action_stationarity",
  ].includes(cancellationCategory ?? "");
  const state = !active && stopReason === "cancelled" && !abnormalCancellation
    ? "stopped"
    : failedToolCount > 0
        || (!active && (abnormalStop || abnormalCancellation || unfinishedToolCount > 0))
      ? "attention"
    : active
      ? "running"
      : "complete";

  let title: string;
  if (state === "stopped") {
    title = cancelledProcessTitle(cancellationCategory, cancelTrigger);
  } else if (state === "attention") {
    title = active
      ? "执行遇到问题，正在继续处理"
      : abnormalCancellation
        ? cancelledProcessTitle(cancellationCategory)
      : abnormalStop
        ? abnormalProcessTitle(stopReason)
        : unfinishedToolCount > 0
          ? "执行已结束，但有操作未收尾"
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

function cancelledProcessTitle(category?: string, trigger?: string): string {
  if (trigger === "send_now") return "已切换到新请求";
  switch (category) {
    case "max_turns_reached":
      return "已达到执行轮数上限";
    case "PermissionRejected":
      return "权限未批准，执行已停止";
    case "PermissionCancelled":
      return "权限请求已取消";
    case "HookDenied":
      return "执行被安全规则阻止";
    case "action_stationarity":
      return "执行因无进展而停止";
    default:
      return "已停止执行";
  }
}

function abnormalProcessTitle(stopReason?: string): string {
  if (stopReason === "refusal" || stopReason === "content_filter") {
    return "模型未能处理本次请求";
  }
  if (stopReason === "max_tokens") return "回复达到长度上限";
  if (stopReason === "max_turns") return "已达到执行轮数上限";
  return "执行未正常完成";
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
    case "personal-knowledge":
      return "正在检索个人知识";
    default:
      return "正在执行操作";
  }
}
