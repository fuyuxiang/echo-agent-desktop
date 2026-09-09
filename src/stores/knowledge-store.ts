import { create } from "zustand";

export type KnowledgeMode = "auto" | "off";

export type KnowledgeRetrievalStatus =
  | { state: "idle" }
  | { state: "searching" }
  | {
      state: "used";
      resultCount: number;
      sourceCount: number;
      titles: string[];
      items: Array<{ title: string; path?: string }>;
    }
  | { state: "no-match"; sourceCount: number }
  | { state: "blocked"; message: string }
  | { state: "error"; message: string };

interface PersistedKnowledgePreferences {
  defaultMode: KnowledgeMode;
  sessionModes: Record<string, KnowledgeMode>;
}

interface KnowledgeState extends PersistedKnowledgePreferences {
  sourceCount: number;
  retrievals: Record<string, KnowledgeRetrievalStatus>;
  setDefaultMode: (mode: KnowledgeMode) => void;
  setSessionMode: (sessionId: string, mode: KnowledgeMode) => void;
  bindSessionMode: (sessionId: string) => KnowledgeMode;
  setSourceCount: (count: number) => void;
  setRetrieval: (sessionId: string, status: KnowledgeRetrievalStatus) => void;
}

const STORAGE_KEY = "echoagent.knowledge-preferences.v1";

function parseMode(value: unknown): KnowledgeMode | null {
  return value === "auto" || value === "off" ? value : null;
}

function loadPreferences(): PersistedKnowledgePreferences {
  const fallback: PersistedKnowledgePreferences = { defaultMode: "auto", sessionModes: {} };
  if (typeof localStorage === "undefined") return fallback;
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as unknown;
    if (!parsed || typeof parsed !== "object") return fallback;
    const raw = parsed as Record<string, unknown>;
    const sessionModes: Record<string, KnowledgeMode> = {};
    if (raw.sessionModes && typeof raw.sessionModes === "object") {
      for (const [sessionId, value] of Object.entries(raw.sessionModes as Record<string, unknown>).slice(-500)) {
        const mode = parseMode(value);
        if (mode && sessionId.trim()) sessionModes[sessionId] = mode;
      }
    }
    return {
      defaultMode: parseMode(raw.defaultMode) ?? "auto",
      sessionModes,
    };
  } catch {
    return fallback;
  }
}

function persistPreferences(state: Pick<KnowledgeState, "defaultMode" | "sessionModes">): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      defaultMode: state.defaultMode,
      sessionModes: state.sessionModes,
    }));
  } catch {
    // Preference persistence must never block a task submission.
  }
}

const initial = loadPreferences();

export const useKnowledgeStore = create<KnowledgeState>((set, get) => ({
  ...initial,
  sourceCount: 0,
  retrievals: {},
  setDefaultMode: (defaultMode) => set((state) => {
    const next = { ...state, defaultMode };
    persistPreferences(next);
    return { defaultMode };
  }),
  setSessionMode: (sessionId, mode) => set((state) => {
    const sessionModes = { ...state.sessionModes, [sessionId]: mode };
    persistPreferences({ ...state, sessionModes });
    return { sessionModes };
  }),
  bindSessionMode: (sessionId) => {
    const state = get();
    const existing = state.sessionModes[sessionId];
    if (existing) return existing;
    const mode = state.defaultMode;
    const sessionModes = { ...state.sessionModes, [sessionId]: mode };
    persistPreferences({ ...state, sessionModes });
    set({ sessionModes });
    return mode;
  },
  setSourceCount: (sourceCount) => set({ sourceCount: Math.max(0, sourceCount) }),
  setRetrieval: (sessionId, status) => set((state) => ({
    retrievals: { ...state.retrievals, [sessionId]: status },
  })),
}));

export function knowledgeModeForSession(sessionId?: string): KnowledgeMode {
  const state = useKnowledgeStore.getState();
  return sessionId ? state.sessionModes[sessionId] ?? state.defaultMode : state.defaultMode;
}
