import { invoke } from "@tauri-apps/api/core";
import type { ToolCallView } from "@/stores/session-store";

export type OfficeFormat = "docx" | "pdf" | "xlsx" | "pptx";

export interface DocumentExportReceipt {
  path: string;
  format: OfficeFormat;
  byteSize: number;
  sha256: string;
}

export function isOfficeCreateTool(toolCall: ToolCallView): boolean {
  return toolCall.officeReceipt != null
    || /echoagent-office__office_create/i.test(`${toolCall.kind} ${toolCall.title}`);
}

function validReceipt(value: unknown): DocumentExportReceipt | null {
  if (!value || typeof value !== "object") return null;
  const receipt = value as Record<string, unknown>;
  if (typeof receipt.path !== "string"
    || !["docx", "pdf", "xlsx", "pptx"].includes(String(receipt.format))
    || typeof receipt.byteSize !== "number" || receipt.byteSize <= 0
    || !/^[a-f0-9]{64}$/i.test(String(receipt.sha256))) return null;
  return receipt as unknown as DocumentExportReceipt;
}

/** UI and artifact catalog use only receipts validated from Runtime rawOutput. */
export function officeReceiptFromToolCall(toolCall: ToolCallView): DocumentExportReceipt | null {
  if (!isOfficeCreateTool(toolCall) || toolCall.status !== "completed") return null;
  return validReceipt(toolCall.officeReceipt);
}

/** Runtime publishes MCP results in ACP rawOutput, without content blocks. */
export function officeReceiptFromRawOutput(raw: unknown): DocumentExportReceipt | null {
  if (!raw || typeof raw !== "object") return null;
  const output = raw as Record<string, unknown>;
  if (output.type !== "MCP"
    || output.is_error === true
    || output.server_name !== "echoagent-office"
    || (output.tool_name !== "office_create"
      && output.tool_name !== "echoagent-office__office_create")) return null;
  const details = output.output;
  if (!details || typeof details !== "object") return null;
  const text = (details as Record<string, unknown>).OkayOutput;
  if (typeof text !== "string" || text.length > 4096) return null;
  try { return validReceipt(JSON.parse(text)); } catch { return null; }
}

export function exportOfficeDocument(
  title: string,
  markdown: string,
  format: OfficeFormat,
): Promise<DocumentExportReceipt | null> {
  return invoke("document_export", { request: { title, markdown, format } });
}
