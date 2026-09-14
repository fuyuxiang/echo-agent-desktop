/**
 * Subagent live runtime store — 对齐 EchoAgent `team-runtime` / `getSubagentList`。
 *
 * Receives `agent://subagent` events forwarded by bridge.rs from both the live
 * and durable replay rails. Maintains a per-parent-session map of active and
 * completed subagents with task provenance, progress and final evidence.
 */
import { create } from "zustand";
import type { SubagentLiveEvent } from "@/lib/types";

export interface SubagentRuntime {
  /** Subagent id (= child session id). */
  id: string;
  /** Child session id (may differ on resume). */
  childSessionId?: string;
  /** Parent prompt/turn that created the child. */
  parentPromptId?: string;
  /** Human-readable description / task title. */
  description: string;
  /** Agent type ("general-purpose", "explore", etc.). */
  subagentType?: string;
  model?: string;
  persona?: string;
  role?: string;
  effectiveContextSource?: string;
  contextNormalized?: boolean;
  capabilityMode?: string;
  resumedFrom?: string;
  workflowRunId?: string;
  /** "running" | "completed" | "failed" | "cancelled". */
  status: string;
  /** Elapsed wall-clock time in ms. */
  durationMs?: number;
  /** Completed turns. */
  turnCount?: number;
  /** Total tool calls. */
  toolCallCount?: number;
  /** Tokens used. */
  tokensUsed?: number;
  /** Context window capacity in tokens. */
  contextWindowTokens?: number;
  /** Context usage percentage (0-100). */
  contextUsagePct?: number;
  /** Distinct tool names called. */
  toolsUsed?: string[];
  errorCount?: number;
  /** Error message (finished only). */
  error?: string;
  /** Final output (finished only). */
  output?: string;
  /** Durable ordering metadata. */
  occurredAt?: number;
  isReplay?: boolean;
}

interface SubagentState {
  /** parentSessionId → subagentId → runtime (insertion-ordered via Map). */
  bySession: Record<string, Record<string, SubagentRuntime>>;
  /** Apply a agent://subagent event (spawned/progress/finished). */
  applyEvent: (e: SubagentLiveEvent) => void;
  /** Get all subagents for a session, ordered by insertion (running first). */
  getForSession: (sessionId: string | null) => SubagentRuntime[];
  /** Remove finished subagents for a session (cleanup after dismissal). */
  clearFinished: (sessionId: string) => void;
  /** Drop all subagents for a session (deletion or before authoritative replay). */
  clearSession: (sessionId: string) => void;
}

export const useSubagentStore = create<SubagentState>((set, get) => ({
  bySession: {},

  applyEvent: (e) =>
    set((s) => {
      const sessionMap = s.bySession[e.sessionId] ?? {};
      const prev = sessionMap[e.subagentId];
      // A late/replayed spawn or progress event must enrich a terminal record,
      // never regress it back to "running". This also makes duplicate replay
      // bursts idempotent when a session was already live in memory.
      const prevIsTerminal = prev != null && prev.status !== "running";
      const incomingStatus = e.status ?? prev?.status ?? "running";
      const status = prevIsTerminal && e.phase !== "finished"
        ? prev.status
        : incomingStatus;
      const next: SubagentRuntime = {
        id: e.subagentId,
        childSessionId: e.childSessionId ?? prev?.childSessionId,
        parentPromptId: e.parentPromptId ?? prev?.parentPromptId,
        description: e.description ?? prev?.description ?? "",
        subagentType: e.subagentType ?? prev?.subagentType,
        model: e.model ?? prev?.model,
        persona: e.persona ?? prev?.persona,
        role: e.role ?? prev?.role,
        effectiveContextSource: e.effectiveContextSource ?? prev?.effectiveContextSource,
        contextNormalized: e.contextNormalized ?? prev?.contextNormalized,
        capabilityMode: e.capabilityMode ?? prev?.capabilityMode,
        resumedFrom: e.resumedFrom ?? prev?.resumedFrom,
        workflowRunId: e.workflowRunId ?? prev?.workflowRunId,
        status,
        durationMs: e.durationMs ?? prev?.durationMs,
        turnCount: e.turnCount ?? prev?.turnCount,
        toolCallCount: e.toolCallCount ?? prev?.toolCallCount,
        tokensUsed: e.tokensUsed ?? prev?.tokensUsed,
        contextWindowTokens: e.contextWindowTokens ?? prev?.contextWindowTokens,
        contextUsagePct: e.contextUsagePct ?? prev?.contextUsagePct,
        toolsUsed: e.toolsUsed ?? prev?.toolsUsed,
        errorCount: e.errorCount ?? prev?.errorCount,
        error: e.error ?? prev?.error,
        output: e.output ?? prev?.output,
        occurredAt: e.occurredAt ?? prev?.occurredAt,
        isReplay: e.isReplay ?? prev?.isReplay,
      };
      return {
        bySession: {
          ...s.bySession,
          [e.sessionId]: { ...sessionMap, [e.subagentId]: next },
        },
      };
    }),

  getForSession: (sessionId) => {
    if (!sessionId) return [];
    const map = get().bySession[sessionId];
    if (!map) return [];
    // Sort: running first, then by insertion order.
    return Object.values(map).sort((a, b) => {
      const aRunning = a.status === "running" ? 0 : 1;
      const bRunning = b.status === "running" ? 0 : 1;
      return aRunning - bRunning;
    });
  },

  clearFinished: (sessionId) =>
    set((s) => {
      const map = s.bySession[sessionId];
      if (!map) return s;
      const filtered: Record<string, SubagentRuntime> = {};
      for (const [id, rt] of Object.entries(map)) {
        if (rt.status === "running") filtered[id] = rt;
      }
      return { bySession: { ...s.bySession, [sessionId]: filtered } };
    }),

  clearSession: (sessionId) =>
    set((s) => {
      if (!s.bySession[sessionId]) return s;
      const next = { ...s.bySession };
      delete next[sessionId];
      return { bySession: next };
    }),
}));
