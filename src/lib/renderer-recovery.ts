import { useSyncExternalStore } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface RendererRecoveryStatus {
  phase: "ready" | "recovering" | "restored" | "failed";
  attempt: number;
  maxAttempts: number;
  message: string;
  windowGeneration: number;
}
let snapshot: RendererRecoveryStatus | null = null;
const listeners = new Set<() => void>();
function publish(next: RendererRecoveryStatus) {
  if (snapshot && JSON.stringify(next) === JSON.stringify(snapshot)) return;
  snapshot = next;
  for (const listener of listeners) listener();
}
export function useRendererRecoveryStatus() {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => snapshot, () => null);
}

/** Started once per document, independently of model/server initialization. */
export function startRendererHealth(): () => void {
  if (!isTauri()) return () => {};
  const documentId = crypto.randomUUID();
  let disposed = false;
  let busy = false;
  let epoch: number | undefined;
  let unlisten: UnlistenFn | undefined;
  async function pulse() {
    if (disposed || busy) return;
    busy = true;
    try {
      if (epoch === undefined) {
        const status = await invoke<RendererRecoveryStatus>("desktop_recovery_status");
        if (disposed) return;
        epoch = status.windowGeneration;
        publish(status);
      }
      const status = await invoke<RendererRecoveryStatus>("desktop_renderer_heartbeat", { documentId, windowGeneration: epoch });
      if (!disposed) publish(status);
    } catch {
      // Native window replacement can race the first handshake. Reacquire the
      // generation, never reset/reinitialize the healthy agent to recover IPC.
      epoch = undefined;
    } finally { busy = false; }
  }
  void listen<RendererRecoveryStatus>("desktop://renderer-recovery", ({ payload }) => { if (!disposed) publish(payload); })
    .then((stop) => { if (disposed) stop(); else unlisten = stop; }).catch(() => {});
  void pulse();
  const interval = setInterval(() => { void pulse(); }, 5_000);
  return () => { disposed = true; clearInterval(interval); unlisten?.(); };
}
