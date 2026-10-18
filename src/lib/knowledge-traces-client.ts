import { invoke } from "@tauri-apps/api/core";
import { isTauriAvailable } from "./tauri-kb-reader";
import { useKnowledgeStore, type KnowledgeTurnTrace } from "@/stores/knowledge-store";

function validTrace(value: unknown): value is KnowledgeTurnTrace {
  if (!value || typeof value !== "object") return false;
  const trace = value as KnowledgeTurnTrace;
  if (!Array.isArray(trace.selectedSources) || trace.selectedSources.some(source => source !== "personal" && source !== "organization")) return false;
  if (trace.personal?.state === "used") return Array.isArray(trace.personal.items) && trace.personal.items.every(item => typeof item.title === "string") && typeof trace.personal.resultCount === "number";
  return !trace.personal || ["idle", "no-match", "blocked", "error"].includes(trace.personal.state);
}

/** Save before submitting the model prompt, so its citations survive a crash. */
export async function persistKnowledgeTrace(sessionId: string, promptId?: string): Promise<void> {
  if (!promptId || !isTauriAvailable() || sessionId.startsWith("group:")) return;
  const trace = useKnowledgeStore.getState().turnTraces[sessionId]?.[promptId];
  if (!trace || !trace.selectedSources.length) return;
  await invoke("knowledge_trace_save", { sessionId, promptId, trace });
}

export async function hydrateKnowledgeTraces(sessionId: string): Promise<void> {
  if (!isTauriAvailable()) return;
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const raw: { traces: unknown; nextCursor: string | null } | null = await invoke<{ traces: unknown; nextCursor: string | null } | null>("knowledge_traces_load", { sessionId, cursor });
    if (raw == null) return; // A legacy bridge/fixture has no provenance payload.
    if (!raw.traces || typeof raw.traces !== "object" || Array.isArray(raw.traces)) throw new Error("历史知识来源记录格式无效");
    const restored: Record<string, KnowledgeTurnTrace> = {};
    for (const [id, trace] of Object.entries(raw.traces)) {
      if (!validTrace(trace)) throw new Error("历史知识来源记录不可读，原记录已保留");
      restored[id] = trace;
    }
    useKnowledgeStore.getState().restoreTurnTraces(sessionId, restored);
    cursor = raw.nextCursor;
    if (cursor && (typeof cursor !== "string" || seen.has(cursor))) throw new Error("历史知识来源分页无效");
    if (cursor) seen.add(cursor);
  } while (cursor);
}
