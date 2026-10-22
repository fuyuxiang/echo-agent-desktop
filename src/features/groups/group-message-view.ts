import type { ChatMessage, ToolCallView } from "@/stores/session-store";
import { normalizeToolCallContent } from "@/stores/session-store";
import { officeReceiptFromRawOutput } from "@/lib/document-export";
import type { GroupMessage, GroupWork } from "./group-client";

const views = new WeakMap<GroupMessage, { status?: string; error?: string | null; view: ChatMessage }>();

/** Work is the source of truth; one member turn contains its answer and tools. */
export function groupMessageView(message: GroupMessage, work?: GroupWork): ChatMessage {
  const cached = views.get(message);
  if (cached && cached.status === work?.status && cached.error === work?.error) return cached.view;
  const complete = !work || !["dispatching", "running", "stopping"].includes(work.status);
  const view: ChatMessage = {
    id: message.id, role: message.kind === "user" ? "user" : "assistant", complete,
    attachments: message.attachments,
    ...(work?.status === "cancelled" ? { stopReason: "cancelled" } : work?.status === "failed" ? { stopReason: "error", agentResult: work.error ?? undefined } : {}),
    parts: [
      ...message.toolCalls.map(call => ({ kind: "tool_call" as const, toolCall: {
        toolCallId: String(call.toolCallId), title: String(call.title ?? "执行操作"), kind: String(call.kind ?? "other"),
        status: String(call.status ?? "in_progress") as ToolCallView["status"], content: normalizeToolCallContent(call.content),
        rawInput: call.rawInput, officeReceipt: officeReceiptFromRawOutput(call.rawOutput) ?? undefined,
      } as ToolCallView })),
      ...(message.text ? [{ kind: "text" as const, text: message.text }] : []),
    ],
  };
  views.set(message, { status: work?.status, error: work?.error, view });
  return view;
}
