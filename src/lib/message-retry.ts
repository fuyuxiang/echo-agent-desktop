import type { ChatMessage } from "@/stores/session-store";
import { partitionAssistantParts } from "@/lib/execution-process";

/**
 * The three actions deliberately have different product semantics:
 * - regenerate: replace a text-only answer with another answer;
 * - reexecute: run a tool-using turn again (may repeat side effects);
 * - retry: retry a turn that failed before it produced an answer or tool work.
 */
export type MessageRetryKind = "regenerate" | "reexecute" | "retry";

export interface MessageRetrySendRequest {
  sessionId: string;
  displayText: string;
  promptText: string;
  attachments: string[];
  kind: MessageRetryKind;
}

export function messageRetryKind(message: ChatMessage): MessageRetryKind {
  if (message.parts.some((part) => part.kind === "tool_call")) return "reexecute";

  const groups = partitionAssistantParts(message.parts);
  const hasAnswer = groups.responseParts.some(
    (part) => part.kind === "text" && part.text.trim().length > 0,
  );
  const stoppedAbnormally = Boolean(
    message.stopReason
      && message.cancelTrigger !== "send_now"
      && (message.stopReason !== "end_turn" || message.cancellationCategory),
  );

  return hasAnswer && !stoppedAbnormally ? "regenerate" : "retry";
}

export function messageRetryLabel(kind: MessageRetryKind, busy = false): string {
  if (kind === "reexecute") return busy ? "正在重新执行…" : "重新执行";
  if (kind === "retry") return busy ? "正在重试…" : "重试";
  return busy ? "正在重新生成…" : "重新生成";
}

export function messageRetryTitle(kind: MessageRetryKind): string {
  if (kind === "reexecute") return "重新执行本轮任务（可能再次调用工具）";
  if (kind === "retry") return "重试本轮请求";
  return "重新生成回复";
}
