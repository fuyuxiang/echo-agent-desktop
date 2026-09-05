import { create } from "zustand";
import type { SessionSummary, SessionStatus } from "@/lib/types";
import type { WorkspaceInfo } from "@/lib/agent-client";

/**
 * Sentinel draft keys for sessions that don't have a real sessionId yet.
 * Used when the user is typing on HomePage before a session has been created.
 */
export const HOME_DRAFT_KEY = "__home__";

/**
 * Session catalog and sidebar presentation state.
 *
 * `independent` is the complete persisted session catalog across every cwd.
 * A cwd is execution context for the agent and never decides whether a row is
 * a task or a project. The sidebar derives project membership from explicit
 * project references. `workspaces` only supplies the Composer's working-directory
 * picker, while `homeCwd` is the default target for newly created sessions.
 */
interface SessionsState {
  /** Complete task/session catalog across historical working directories. */
  independent: SessionSummary[];
  /** Recent working directories shown only in cwd pickers. */
  workspaces: WorkspaceInfo[];
  /** 任务分组 collapsed? (default expanded). */
  tasksOpen: boolean;
  /** 项目分组 collapsed? (default expanded). */
  projectsOpen: boolean;
  /** Default working directory used when a new task has no explicit selection. */
  homeCwd: string;
  currentSessionId: string | null;
  loading: boolean;
  error: string | null;
  /** Search query for the session search overlay (empty = no filter). */
  query: string;
  /** Sidebar task filter: selected status (null = 全部状态). */
  filterStatus: SessionStatus | null;
  /** Sidebar task filter: selected date range (null = 全部时间). */
  filterDate: string | null;
  /** Show archived sessions instead of active sessions. */
  filterArchived: boolean;
  /**
   * Patches such as `agent://summary` can arrive before the catalog row with its
   * cwd. Keep them until a complete summary arrives.
   */
  pendingSessionPatches: Record<string, Partial<SessionSummary>>;
  /**
   * Per-session Composer drafts (unsent textarea text), keyed by sessionId.
   * UI-only state: EchoAgent has no concept of "user hasn't pressed send yet", so
   * we keep it here the same way we keep pinned/archived (see meta.rs).
   * The `__home__` sentinel covers the HomePage ("新建任务") input.
   */
  drafts: Record<string, string>;

  setIndependent: (list: SessionSummary[]) => void;
  /** Merge a partial cwd-scoped hydration into the complete catalog. */
  mergeSessions: (list: SessionSummary[]) => void;
  setWorkspaces: (list: WorkspaceInfo[]) => void;
  setTasksOpen: (b: boolean) => void;
  setProjectsOpen: (b: boolean) => void;
  setHomeCwd: (cwd: string) => void;
  setLoading: (b: boolean) => void;
  setError: (e: string | null) => void;
  setCurrent: (id: string | null) => void;
  setQuery: (q: string) => void;
  setFilterStatus: (s: SessionStatus | null) => void;
  setFilterDate: (d: string | null) => void;
  setFilterArchived: (archived: boolean) => void;
  clearFilters: () => void;
  /** Save the draft for one session id. Empty string deletes the entry so
   *  the map stays tidy and `drafts[id] ?? ""` always reflects truth. */
  setDraft: (id: string, text: string) => void;
  /** Drop the draft for one session id (no-op if absent). */
  clearDraft: (id: string) => void;
  /** Insert or merge a session entry. A cwd-less patch updates an existing row
   *  or waits for a later authoritative catalog hydration. */
  upsert: (s: Partial<SessionSummary> & { sessionId: string }) => void;
  /** Remove a session and update the working-directory picker count. */
  remove: (id: string, cwd?: string) => void;
}

/** Returns true when any sidebar task filter is active. */
export function selectHasFilter(s: {
  filterStatus: SessionStatus | null;
  filterDate: string | null;
  filterArchived: boolean;
}): boolean {
  return s.filterStatus !== null || s.filterDate !== null || s.filterArchived;
}

export const useSessionsStore = create<SessionsState>((set) => ({
  independent: [],
  workspaces: [],
  tasksOpen: true,
  projectsOpen: true,
  homeCwd: "",
  currentSessionId: null,
  loading: false,
  error: null,
  query: "",
  filterStatus: null,
  filterDate: null,
  filterArchived: false,
  pendingSessionPatches: {},
  drafts: {},

  setIndependent: (incoming) =>
    set((state) => {
      const pendingSessionPatches = { ...state.pendingSessionPatches };
      const independent = incoming.map((entry) => {
        const patch = pendingSessionPatches[entry.sessionId];
        if (!patch) return entry;
        delete pendingSessionPatches[entry.sessionId];
        return { ...entry, ...patch, cwd: entry.cwd };
      });
      return { independent, pendingSessionPatches };
    }),
  mergeSessions: (incoming) =>
    set((state) => {
      const independent = [...state.independent];
      const pendingSessionPatches = { ...state.pendingSessionPatches };
      for (const entry of incoming) {
        const patch = pendingSessionPatches[entry.sessionId];
        delete pendingSessionPatches[entry.sessionId];
        const merged = patch
          ? { ...entry, ...patch, cwd: entry.cwd }
          : entry;
        const index = independent.findIndex((item) => item.sessionId === entry.sessionId);
        if (index === -1) independent.unshift(merged);
        else independent[index] = { ...independent[index], ...merged };
      }
      return { independent, pendingSessionPatches };
    }),
  setWorkspaces: (workspaces) => set({ workspaces }),
  setTasksOpen: (tasksOpen) => set({ tasksOpen }),
  setProjectsOpen: (projectsOpen) => set({ projectsOpen }),
  setHomeCwd: (homeCwd) => set({ homeCwd }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  setCurrent: (id) => set({ currentSessionId: id }),
  setQuery: (query) => set({ query }),
  setFilterStatus: (filterStatus) => set({ filterStatus }),
  setFilterDate: (filterDate) => set({ filterDate }),
  setFilterArchived: (filterArchived) => set({ filterArchived }),
  clearFilters: () => set({ filterStatus: null, filterDate: null, filterArchived: false }),
  setDraft: (id, text) =>
    set((state) => {
      // Avoid a new object reference when nothing changes (no text + absent).
      if (text === "") {
        if (!Object.prototype.hasOwnProperty.call(state.drafts, id)) return {};
        const next = { ...state.drafts };
        delete next[id];
        return { drafts: next };
      }
      if (state.drafts[id] === text) return {};
      return { drafts: { ...state.drafts, [id]: text } };
    }),
  clearDraft: (id) =>
    set((state) => {
      if (!Object.prototype.hasOwnProperty.call(state.drafts, id)) return {};
      const next = { ...state.drafts };
      delete next[id];
      return { drafts: next };
    }),

  upsert: (s) =>
    set((state) => {
      const id = s.sessionId;
      const pending = state.pendingSessionPatches[id];
      const patch = pending ? { ...pending, ...s } : s;
      const pendingSessionPatches = { ...state.pendingSessionPatches };
      delete pendingSessionPatches[id];

      // Update the authoritative catalog row when it has already been hydrated.
      const iIdx = state.independent.findIndex((x) => x.sessionId === id);
      if (iIdx !== -1) {
        const independent = [...state.independent];
        independent[iIdx] = { ...independent[iIdx], ...patch };
        return { independent, pendingSessionPatches };
      }

      // A brand-new event without cwd cannot safely create a complete row.
      const cwd = patch.cwd ?? "";
      if (!cwd) {
        // A summary/title/status notification is not enough to route a brand-new
        // row. Retain it until list_sessions or a caller supplies the cwd.
        return {
          pendingSessionPatches: {
            ...state.pendingSessionPatches,
            [id]: { ...state.pendingSessionPatches[id], ...patch },
          },
        };
      }
      const inserted: SessionSummary = {
        title: "未命名会话",
        cwd,
        ...patch,
        updatedAt: patch.updatedAt ?? new Date().toISOString(),
      };
      // Keep the picker useful immediately after a session is created in a
      // manually selected folder. A later backend refresh corrects the count.
      const existingWorkspace = state.workspaces.find((workspace) => workspace.cwd === cwd);
      const workspaces = existingWorkspace
        ? state.workspaces.map((workspace) => workspace.cwd === cwd
            ? { ...workspace, sessionCount: workspace.sessionCount + 1, lastTitle: inserted.title }
            : workspace)
        : [{ cwd, sessionCount: 1, lastTitle: inserted.title }, ...state.workspaces];
      return {
        independent: [inserted, ...state.independent],
        workspaces,
        pendingSessionPatches,
      };
    }),

  remove: (id, explicitCwd) =>
    set((state) => {
      const removed = state.independent.find((x) => x.sessionId === id);
      const independent = state.independent.filter((x) => x.sessionId !== id);

      // Optimistically update the matching working-directory picker entry.
      const authoritativeCwd = removed?.cwd ?? explicitCwd ?? null;
      const workspaces =
        authoritativeCwd == null
          ? state.workspaces
          : state.workspaces
              .map((w) => w.cwd === authoritativeCwd
                ? { ...w, sessionCount: Math.max(0, w.sessionCount - 1) }
                : w)
              .filter((w) => w.sessionCount > 0);

      // Drop the deleted session's draft too, so the map doesn't grow forever.
      let drafts = state.drafts;
      if (Object.prototype.hasOwnProperty.call(state.drafts, id)) {
        drafts = { ...state.drafts };
        delete drafts[id];
      }

      const pendingSessionPatches = { ...state.pendingSessionPatches };
      delete pendingSessionPatches[id];

      // If neither the visible lists nor an explicit cwd knew this id, preserve
      // object identity and counts instead of applying a speculative decrement.
      const found = !!removed || !!state.pendingSessionPatches[id];
      if (!found && !explicitCwd) return {};

      return {
        independent,
        workspaces,
        drafts,
        pendingSessionPatches,
        currentSessionId:
          state.currentSessionId === id ? null : state.currentSessionId,
      };
    }),
}));
