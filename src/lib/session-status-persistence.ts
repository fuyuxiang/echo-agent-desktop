import { invoke } from "@tauri-apps/api/core";
import type { SessionStatus } from "./types";

const MAX_AUTOMATIC_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [250, 1_000] as const;

interface PendingStatusWrite {
  sessionId: string;
  status: SessionStatus;
  updatedAt: string;
  revision: number;
  attempts: number;
  inFlight: boolean;
  timer?: ReturnType<typeof setTimeout>;
  notifiedRevision?: number;
}

export interface SessionStatusPersistenceIssue {
  sessionId: string;
  status: SessionStatus;
  pendingCount: number;
  error: unknown;
}

const pending = new Map<string, PendingStatusWrite>();
const issueListeners = new Set<(issue: SessionStatusPersistenceIssue) => void>();

function tauriAvailable(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function notifyFailure(entry: PendingStatusWrite, error: unknown): void {
  if (entry.notifiedRevision === entry.revision) return;
  entry.notifiedRevision = entry.revision;
  console.warn("[EchoAgent] 会话状态持久化失败", {
    sessionId: entry.sessionId,
    status: entry.status,
    error,
  });
  const issue = {
    sessionId: entry.sessionId,
    status: entry.status,
    pendingCount: pending.size,
    error,
  };
  for (const listener of issueListeners) {
    try {
      listener(issue);
    } catch (listenerError) {
      console.warn("[EchoAgent] 会话状态持久化失败监听器异常", listenerError);
    }
  }
}

async function flushSessionStatus(sessionId: string): Promise<void> {
  const entry = pending.get(sessionId);
  if (!entry || entry.inFlight || !tauriAvailable()) return;

  entry.inFlight = true;
  const revision = entry.revision;
  const status = entry.status;
  const updatedAt = entry.updatedAt;
  try {
    await invoke<void>("agent_set_session_status", { sessionId, status, updatedAt });
    const current = pending.get(sessionId);
    if (!current) return;
    current.inFlight = false;
    if (current.revision === revision) {
      pending.delete(sessionId);
    } else {
      void flushSessionStatus(sessionId);
    }
  } catch (error) {
    const current = pending.get(sessionId);
    if (!current) return;
    current.inFlight = false;
    if (current.revision !== revision) {
      void flushSessionStatus(sessionId);
      return;
    }

    current.attempts += 1;
    if (current.attempts < MAX_AUTOMATIC_ATTEMPTS) {
      const delay = RETRY_DELAYS_MS[current.attempts - 1] ?? RETRY_DELAYS_MS[1];
      current.timer = setTimeout(() => {
        const latest = pending.get(sessionId);
        if (latest) latest.timer = undefined;
        void flushSessionStatus(sessionId);
      }, delay);
      return;
    }
    notifyFailure(current, error);
  }
}

/**
 * Persist a lifecycle transition without blocking streaming. Writes are
 * coalesced per session, retried in order, and keep the newest timestamp so an
 * earlier slow IPC response can never overwrite a newer terminal state.
 */
export function persistSessionStatus(
  sessionId: string,
  status: SessionStatus,
  updatedAt: string,
): void {
  if (!tauriAvailable()) return;

  const existing = pending.get(sessionId);
  if (existing) {
    existing.status = status;
    existing.updatedAt = updatedAt;
    existing.revision += 1;
    existing.attempts = 0;
    existing.notifiedRevision = undefined;
    if (existing.timer) {
      clearTimeout(existing.timer);
      existing.timer = undefined;
    }
    if (!existing.inFlight) void flushSessionStatus(sessionId);
    return;
  }

  pending.set(sessionId, {
    sessionId,
    status,
    updatedAt,
    revision: 1,
    attempts: 0,
    inFlight: false,
  });
  void flushSessionStatus(sessionId);
}

/** Retry all writes that exhausted their automatic attempts. */
export function retryPendingSessionStatuses(): number {
  const retryCount = pending.size;
  for (const entry of pending.values()) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.attempts = 0;
    entry.notifiedRevision = undefined;
    if (!entry.inFlight) void flushSessionStatus(entry.sessionId);
  }
  return retryCount;
}

/** Subscribe to durable-write failures after automatic recovery is exhausted. */
export function onSessionStatusPersistenceIssue(
  listener: (issue: SessionStatusPersistenceIssue) => void,
): () => void {
  issueListeners.add(listener);
  return () => issueListeners.delete(listener);
}

/** Test-only cleanup for module-level retry queues and timers. */
export function resetSessionStatusPersistenceForTests(): void {
  for (const entry of pending.values()) {
    if (entry.timer) clearTimeout(entry.timer);
  }
  pending.clear();
  issueListeners.clear();
}
