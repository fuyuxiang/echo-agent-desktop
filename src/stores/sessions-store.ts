import { create } from "zustand";
import type { SessionSummary, SessionStatus } from "@/lib/types";
import type { WorkspaceInfo } from "@/lib/agent-client";

/**
 * Sentinel draft keys for sessions that don't have a real sessionId yet.
 * Used when the user is typing on HomePage before a session has been created.
 */
export const HOME_DRAFT_KEY = "__home__";

/**
 * Sidebar session list — EchoAgent-style two-section model.
 *
 * The sidebar no longer shows a single cwd's sessions flat under one "默认空间".
 * Instead it renders two collapsible groups:
 *
 *   任务 (N)  — `independent`: sessions in the app's initial/home cwd.
 *               The runtime requires absolute paths, so the home cwd is the
 *               inbox grouping key rather than an empty-string sentinel.
 *   空间 (M)  — `workspaces`: one expandable node per local working directory
 *               (sourced from `agentListWorkspaces()`). Expanding a node lazily
 *               loads that cwd's sessions into `workspaceSessions[cwd]`.
 *
 * Kept separate from the active-session transcript store so switching sessions
 * doesn't thrash the list, and each group can refresh independently.
 */
interface SessionsState {
  /** 任务分组: cwd-less (independent) sessions. */
  independent: SessionSummary[];
  /** 空间分组: one node per working directory EchoAgent has seen. */
  workspaces: WorkspaceInfo[];
  /** 空间节点展开后的子会话缓存, keyed by cwd. Absent key = not yet loaded. */
  workspaceSessions: Record<string, SessionSummary[]>;
  /** 任务分组 collapsed? (default expanded). */
  tasksOpen: boolean;
  /** 空间分组 collapsed? (default expanded). */
  spacesOpen: boolean;
  /** Per-cwd expand state for 空间 nodes. */
  expanded: Record<string, boolean>;
  /** The "inbox" cwd = the directory EchoAgent started in. Sessions in this cwd
   *  form the 任务 group; every other cwd is a 空间 node. (EchoAgent rejects empty
   *  cwd, so we cannot use a cwd-less session as the inbox.) */
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
   * Patches such as `agent://summary` can arrive before their owning workspace
   * has been hydrated. Keep them here until a full summary (with cwd) arrives;
   * treating a missing cwd as the inbox would silently move the session to the
   * wrong group.
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
  setWorkspaces: (list: WorkspaceInfo[]) => void;
  setWorkspaceSessions: (cwd: string, list: SessionSummary[]) => void;
  setTasksOpen: (b: boolean) => void;
  setSpacesOpen: (b: boolean) => void;
  setExpanded: (cwd: string, b: boolean) => void;
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
  /** Insert or merge a session entry, routing it into the correct group by
   *  cwd. On update (id already present) the entry is merged in place wherever
   *  it lives, so a cwd-less `{ sessionId, title }` (e.g. agent://summary)
   *  updates the right group without needing the cwd. */
  upsert: (s: Partial<SessionSummary> & { sessionId: string }) => void;
  /** Remove a session from every group and decrement its workspace node count. */
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
  workspaceSessions: {},
  tasksOpen: true,
  spacesOpen: true,
  expanded: {},
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
  setWorkspaces: (workspaces) => set({ workspaces }),
  setWorkspaceSessions: (cwd, list) =>
    set((state) => {
      const pendingSessionPatches = { ...state.pendingSessionPatches };
      const merged = list.map((entry) => {
        const patch = pendingSessionPatches[entry.sessionId];
        if (!patch) return entry;
        delete pendingSessionPatches[entry.sessionId];
        // The hydrated list owns routing. A title-only patch must not change it.
        return { ...entry, ...patch, cwd: entry.cwd || cwd };
      });
      return {
        workspaceSessions: { ...state.workspaceSessions, [cwd]: merged },
        pendingSessionPatches,
      };
    }),
  setTasksOpen: (tasksOpen) => set({ tasksOpen }),
  setSpacesOpen: (spacesOpen) => set({ spacesOpen }),
  setExpanded: (cwd, b) =>
    set((state) => ({ expanded: { ...state.expanded, [cwd]: b } })),
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

      // 1) Update in place if it already lives in the 任务 group.
      const iIdx = state.independent.findIndex((x) => x.sessionId === id);
      if (iIdx !== -1) {
        const independent = [...state.independent];
        independent[iIdx] = { ...independent[iIdx], ...patch };
        return { independent, pendingSessionPatches };
      }

      // 2) Update in place if it already lives in some 空间 node's cache.
      for (const cwd of Object.keys(state.workspaceSessions)) {
        const list = state.workspaceSessions[cwd];
        const wIdx = list.findIndex((x) => x.sessionId === id);
        if (wIdx !== -1) {
          const next = [...list];
          next[wIdx] = { ...next[wIdx], ...patch };
          return {
            workspaceSessions: { ...state.workspaceSessions, [cwd]: next },
            pendingSessionPatches,
          };
        }
      }

      // 3) New entry — route by cwd. The 任务 group is the "inbox" = the cwd
      // EchoAgent started in (homeCwd); EchoAgent rejects empty cwd so every session has
      // an absolute path. A session whose cwd equals homeCwd (or, defensively,
      // an empty cwd) is independent; everything else belongs to a 空间 node.
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
      const isInbox = !cwd || cwd === state.homeCwd;
      if (isInbox) {
        const inserted: SessionSummary = {
          title: "未命名会话",
          cwd: state.homeCwd,
          ...patch,
          // Fresh sessions must carry a timestamp so the sidebar's
          // recently-active sort pins them to the top instead of sinking.
          updatedAt: patch.updatedAt ?? new Date().toISOString(),
        };
        return { independent: [inserted, ...state.independent], pendingSessionPatches };
      }

      // Non-empty cwd ⇒ belongs to a 空间 node. Keep the row even when the
      // node has never been expanded. The next expansion refreshes the canonical
      // list, but until then the newly-created/searched session remains addressable.
      const inserted: SessionSummary = {
        title: "未命名会话",
        cwd,
        ...patch,
        updatedAt: patch.updatedAt ?? new Date().toISOString(),
      };
      const existingWorkspace = state.workspaces.find((workspace) => workspace.cwd === cwd);
      const workspaces = existingWorkspace
        ? state.workspaces.map((workspace) =>
            workspace.cwd === cwd
              ? { ...workspace, sessionCount: workspace.sessionCount + 1, lastTitle: inserted.title }
              : workspace,
          )
        : [{ cwd, sessionCount: 1, lastTitle: inserted.title }, ...state.workspaces];
      return {
        workspaceSessions: {
          ...state.workspaceSessions,
          [cwd]: [inserted, ...(state.workspaceSessions[cwd] ?? [])],
        },
        workspaces,
        pendingSessionPatches,
      };
    }),

  remove: (id, explicitCwd) =>
    set((state) => {
      const removedIndependent = state.independent.find((x) => x.sessionId === id);
      const independent = state.independent.filter((x) => x.sessionId !== id);

      // Drop from any 空间 node cache that holds it, remembering which cwd
      // lost a session so we can keep that node's count in sync.
      let removedCwd: string | null = null;
      const workspaceSessions: Record<string, SessionSummary[]> = {};
      for (const cwd of Object.keys(state.workspaceSessions)) {
        const list = state.workspaceSessions[cwd];
        const next = list.filter((x) => x.sessionId !== id);
        workspaceSessions[cwd] = next;
        if (next.length !== list.length) removedCwd = cwd;
      }

      // Optimistically decrement the affected node's count (floored at 0).
      // A subsequent refresh corrects this against the on-disk truth.
      const authoritativeCwd = removedCwd
        ?? (explicitCwd && explicitCwd !== state.homeCwd ? explicitCwd : null);
      const workspaces =
        authoritativeCwd == null
          ? state.workspaces
          : state.workspaces.map((w) =>
              w.cwd === authoritativeCwd
                ? { ...w, sessionCount: Math.max(0, w.sessionCount - 1) }
                : w,
            );

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
      const found = !!removedIndependent || removedCwd !== null || !!state.pendingSessionPatches[id];
      if (!found && !explicitCwd) return {};

      return {
        independent,
        workspaceSessions,
        workspaces,
        drafts,
        pendingSessionPatches,
        currentSessionId:
          state.currentSessionId === id ? null : state.currentSessionId,
      };
    }),
}));
