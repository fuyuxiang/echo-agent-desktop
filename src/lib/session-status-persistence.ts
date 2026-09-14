import { invoke } from "@tauri-apps/api/core";
import type { SessionStatus } from "./types";

/**
 * Persist lifecycle changes independently from EchoAgent's upstream summary.
 * UI state remains optimistic; a native write failure is diagnostic-only so a
 * status transition can never block streaming, stopping or answering a prompt.
 */
export function persistSessionStatus(
  sessionId: string,
  status: SessionStatus,
  updatedAt: string,
): void {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  try {
    void invoke<void>("agent_set_session_status", { sessionId, status, updatedAt }).catch((error) => {
      console.warn("[EchoAgent] 会话状态持久化失败", { sessionId, status, error });
    });
  } catch (error) {
    // Browser-only previews and unit tests do not install Tauri internals.
    console.warn("[EchoAgent] 会话状态持久化不可用", { sessionId, status, error });
  }
}
