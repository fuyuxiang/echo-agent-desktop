import type { ChatMessage } from "@/stores/session-store";

const LOCAL_URL = /\b(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})(?:\/[^\s"'<>]*)?/gi;

export function localPreviewUrls(messages: ChatMessage[]): string[] {
  const found = new Set<string>();
  for (const message of messages.slice(-12).reverse()) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts.slice(-20)) {
      const text = part.kind === "text" ? part.text : part.kind === "tool_call"
        ? JSON.stringify(part.toolCall.content) ?? "" : "";
      for (const match of text.slice(-12_000).matchAll(LOCAL_URL)) {
        const port = Number(match[3]);
        if (!Number.isSafeInteger(port) || port < 1 || port > 65535) continue;
        const host = match[2] === "0.0.0.0" ? "127.0.0.1" : match[2];
        found.add(`${match[1] ?? "http://"}${host}:${port}/`);
        if (found.size >= 4) return [...found];
      }
    }
  }
  return [...found];
}
