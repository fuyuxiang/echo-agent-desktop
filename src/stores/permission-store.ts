import { create } from "zustand";
import type { PermissionRequest } from "@/lib/types";

/**
 * Permission requests indexed by sessionId. Each session owns its own queue
 * so the inline permission card only shows requests for the active session,
 * and switching conversations is never blocked.
 */
interface PermissionState {
  /** sessionId → ordered queue of pending permission requests. */
  queues: Record<string, PermissionRequest[]>;
  /** Recently closed ids prevent a delayed Tauri event from resurrecting a request. */
  closedRequestIds: string[];
  /** Push a new request emitted by the backend. */
  request: (p: PermissionRequest) => void;
  /** Remove a request from its session's queue (without resolving the agent). */
  dismiss: (requestId: string, sessionId?: string) => void;
  /** Authoritatively close a request and remember its id against event reordering. */
  close: (requestId: string, sessionId?: string) => void;
  /** Drop every stale request after the shared agent process exits. */
  clearAll: () => void;
}

const MAX_CLOSED_REQUEST_IDS = 256;

function withoutRequest(
  queues: Record<string, PermissionRequest[]>,
  requestId: string,
  sessionId?: string,
): Record<string, PermissionRequest[]> {
  if (sessionId) {
    const prev = queues[sessionId];
    if (!prev) return queues;
    return { ...queues, [sessionId]: prev.filter((request) => request.requestId !== requestId) };
  }
  return Object.fromEntries(
    Object.entries(queues).map(([sid, requests]) => [
      sid,
      requests.filter((request) => request.requestId !== requestId),
    ]),
  );
}

export const usePermissionStore = create<PermissionState>((set) => ({
  queues: {},
  closedRequestIds: [],
  request: (p) =>
    set((s) => {
      if (s.closedRequestIds.includes(p.requestId)) return s;
      const sid = p.sessionId || "__global";
      const prev = s.queues[sid] ?? [];
      if (prev.some((pending) => pending.requestId === p.requestId)) return s;
      return { queues: { ...s.queues, [sid]: [...prev, p] } };
    }),
  dismiss: (requestId, sessionId) =>
    set((s) => ({ queues: withoutRequest(s.queues, requestId, sessionId) })),
  close: (requestId, sessionId) =>
    set((s) => ({
      queues: withoutRequest(s.queues, requestId, sessionId),
      closedRequestIds: [
        ...s.closedRequestIds.filter((id) => id !== requestId),
        requestId,
      ].slice(-MAX_CLOSED_REQUEST_IDS),
    })),
  clearAll: () => set({ queues: {}, closedRequestIds: [] }),
}));

/** Select the first pending permission for a given session. */
export const selectPermissionForSession =
  (sessionId: string | null) =>
  (s: PermissionState): PermissionRequest | null => {
    if (!sessionId) return null;
    return s.queues[sessionId]?.[0] ?? null;
  };

/** Legacy: head of all queues (used nowhere after migration to inline). */
export const selectPermissionHead = (s: PermissionState): PermissionRequest | null => {
  for (const sid of Object.keys(s.queues)) {
    if (s.queues[sid].length > 0) return s.queues[sid][0];
  }
  return null;
};
