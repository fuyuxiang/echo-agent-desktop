import { create } from "zustand";

export type KnowledgeSource = "personal" | "organization";

export interface KnowledgeRetrievalItem {
  title: string;
  path?: string;
  sourceLabel?: string;
  snippet?: string;
  startLine?: number;
  endLine?: number;
}

export type KnowledgeRetrievalStatus =
  | { state: "idle" }
  | { state: "searching" }
  | {
      state: "used";
      resultCount: number;
      sourceCount: number;
      titles: string[];
      items: KnowledgeRetrievalItem[];
    }
  | { state: "no-match"; sourceCount: number }
  | { state: "blocked"; message: string }
  | { state: "error"; message: string };

export interface KnowledgeTurnTrace {
  selectedSources: KnowledgeSource[];
  personal?: KnowledgeRetrievalStatus;
  organization?: {
    state: "available" | "unavailable";
    message?: string;
  };
}

interface PersistedKnowledgePreferences {
  /** Selection for the next task composer. Consumed when that task is created. */
  defaultSources: KnowledgeSource[];
  /** Knowledge selection is task-owned so later messages keep the same scope. */
  sessionSources: Record<string, KnowledgeSource[]>;
}

interface KnowledgeState extends PersistedKnowledgePreferences {
  sourceCount: number;
  retrievals: Record<string, KnowledgeRetrievalStatus>;
  turnTraces: Record<string, Record<string, KnowledgeTurnTrace>>;
  setDefaultSources: (sources: KnowledgeSource[]) => void;
  setSessionSources: (sessionId: string, sources: KnowledgeSource[]) => void;
  forgetSession: (sessionId: string) => void;
  bindSessionSources: (sessionId: string, consumeDefault?: boolean) => KnowledgeSource[];
  setSourceCount: (count: number) => void;
  beginTurnTrace: (
    sessionId: string,
    promptId: string | undefined,
    sources: KnowledgeSource[],
    organization?: KnowledgeTurnTrace["organization"],
  ) => void;
  setRetrieval: (
    sessionId: string,
    status: KnowledgeRetrievalStatus,
    promptId?: string,
  ) => void;
}

const STORAGE_KEY = "echoagent.knowledge-preferences.v2";
const LEGACY_STORAGE_KEY = "echoagent.knowledge-preferences.v1";
const MAX_PERSISTED_SESSIONS = 500;
const MAX_TURN_TRACES_PER_SESSION = 50;

function normalizeSources(value: unknown): KnowledgeSource[] {
  if (!Array.isArray(value)) return [];
  const selected = new Set<KnowledgeSource>();
  for (const item of value) {
    if (item === "personal" || item === "organization") selected.add(item);
  }
  return (["personal", "organization"] as const).filter((source) => selected.has(source));
}

function loadPreferences(): PersistedKnowledgePreferences {
  const fallback: PersistedKnowledgePreferences = { defaultSources: [], sessionSources: {} };
  if (typeof localStorage === "undefined") return fallback;
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as unknown;
    if (parsed && typeof parsed === "object") {
      const raw = parsed as Record<string, unknown>;
      const sessionSources: Record<string, KnowledgeSource[]> = {};
      if (raw.sessionSources && typeof raw.sessionSources === "object") {
        for (const [sessionId, value] of Object.entries(raw.sessionSources as Record<string, unknown>).slice(-MAX_PERSISTED_SESSIONS)) {
          if (sessionId.trim()) sessionSources[sessionId] = normalizeSources(value);
        }
      }
      return { defaultSources: normalizeSources(raw.defaultSources), sessionSources };
    }

    // V1 had an implicit personal-knowledge switch. Preserve only existing
    // task choices; the next new task intentionally starts with no source.
    const legacy = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) ?? "null") as unknown;
    if (!legacy || typeof legacy !== "object") return fallback;
    const raw = legacy as Record<string, unknown>;
    const sessionSources: Record<string, KnowledgeSource[]> = {};
    if (raw.sessionModes && typeof raw.sessionModes === "object") {
      for (const [sessionId, mode] of Object.entries(raw.sessionModes as Record<string, unknown>).slice(-MAX_PERSISTED_SESSIONS)) {
        if (sessionId.trim()) sessionSources[sessionId] = mode === "auto" ? ["personal"] : [];
      }
    }
    return { defaultSources: [], sessionSources };
  } catch {
    return fallback;
  }
}

function persistPreferences(state: Pick<KnowledgeState, "defaultSources" | "sessionSources">): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      defaultSources: state.defaultSources,
      sessionSources: state.sessionSources,
    }));
  } catch {
    // Preference persistence must never block a task submission.
  }
}

function withBoundedTurnTrace(
  traces: Record<string, KnowledgeTurnTrace>,
  promptId: string,
  trace: KnowledgeTurnTrace,
): Record<string, KnowledgeTurnTrace> {
  const next = { ...traces, [promptId]: trace };
  const keys = Object.keys(next);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_TURN_TRACES_PER_SESSION))) {
    delete next[key];
  }
  return next;
}

const initial = loadPreferences();

export const useKnowledgeStore = create<KnowledgeState>((set, get) => ({
  ...initial,
  sourceCount: 0,
  retrievals: {},
  turnTraces: {},
  setDefaultSources: (sources) => set((state) => {
    const defaultSources = normalizeSources(sources);
    persistPreferences({ ...state, defaultSources });
    return { defaultSources };
  }),
  setSessionSources: (sessionId, sources) => set((state) => {
    const sessionSources = { ...state.sessionSources };
    delete sessionSources[sessionId];
    sessionSources[sessionId] = normalizeSources(sources);
    for (const key of Object.keys(sessionSources).slice(0, Math.max(0, Object.keys(sessionSources).length - MAX_PERSISTED_SESSIONS))) {
      delete sessionSources[key];
    }
    persistPreferences({ ...state, sessionSources });
    return { sessionSources };
  }),
  forgetSession: (sessionId) => set((state) => {
    const sessionSources = { ...state.sessionSources };
    const retrievals = { ...state.retrievals };
    const turnTraces = { ...state.turnTraces };
    delete sessionSources[sessionId];
    delete retrievals[sessionId];
    delete turnTraces[sessionId];
    persistPreferences({ ...state, sessionSources });
    return { sessionSources, retrievals, turnTraces };
  }),
  bindSessionSources: (sessionId, consumeDefault = false) => {
    const state = get();
    const existing = state.sessionSources[sessionId];
    if (existing) return existing;
    const sources = consumeDefault ? normalizeSources(state.defaultSources) : [];
    const sessionSources = { ...state.sessionSources, [sessionId]: sources };
    // A Home composer selection applies to the task being created, not every
    // future task. New tasks therefore return to the privacy-first default.
    const defaultSources = consumeDefault ? [] : state.defaultSources;
    persistPreferences({ defaultSources, sessionSources });
    set({ defaultSources, sessionSources });
    return sources;
  },
  setSourceCount: (sourceCount) => set({ sourceCount: Math.max(0, sourceCount) }),
  beginTurnTrace: (sessionId, promptId, sources, organization) => {
    if (!promptId) return;
    set((state) => ({
      turnTraces: {
        ...state.turnTraces,
        [sessionId]: withBoundedTurnTrace(
          state.turnTraces[sessionId] ?? {},
          promptId,
          {
            selectedSources: normalizeSources(sources),
            ...(organization ? { organization } : {}),
          },
        ),
      },
    }));
  },
  setRetrieval: (sessionId, status, promptId) => set((state) => {
    const retrievals = { ...state.retrievals, [sessionId]: status };
    if (!promptId) return { retrievals };
    const sessionTraces = state.turnTraces[sessionId] ?? {};
    const current = sessionTraces[promptId] ?? {
      selectedSources: knowledgeSourcesForSession(sessionId),
    };
    return {
      retrievals,
      turnTraces: {
        ...state.turnTraces,
        [sessionId]: withBoundedTurnTrace(sessionTraces, promptId, {
          ...current,
          personal: status,
        }),
      },
    };
  }),
}));

export function knowledgeSourcesForSession(sessionId?: string): KnowledgeSource[] {
  const state = useKnowledgeStore.getState();
  return normalizeSources(sessionId
    ? state.sessionSources[sessionId] ?? []
    : state.defaultSources);
}
