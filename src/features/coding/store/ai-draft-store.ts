import { create } from "zustand";

/**
 * Bridge store between the file-tree context menu's AI actions and the
 * workbench's input panes (TaskStarter / AgentPane). Right-click AI entries
 * call `setDraft({ prompt, contextPaths, source })`; the input panes consume
 * the draft on mount via `consume()` and reset it back to `null`.
 *
 * Cross-workbench instance behaviour: zustand stores are singletons, so a
 * draft written from one workbench instance can be picked up by the next.
 * That's intentional — the user is expected to switch panes after issuing
 * an AI action. A TTL guards against stale drafts leaking across very long
 * idle periods.
 */

export type AiDraftSource = "context-menu" | "shortcut" | "drag" | "external";

export interface AiDraft {
  /** Pre-fills the requirement textarea of the next mounted input pane. */
  prompt: string;
  /** Additional paths to feed into the Agent's context window. */
  contextPaths: string[];
  /** Origin of the draft, useful for telemetry + diagnostic logging. */
  source: AiDraftSource;
  /** Wall-clock timestamp (ms since epoch) at which the draft was written. */
  createdAt: number;
}

interface AiDraftState {
  draft: AiDraft | null;
  setDraft: (input: Omit<AiDraft, "createdAt">) => void;
  /** Read the current draft and clear it in one step so it never re-fires. */
  consume: () => AiDraft | null;
  /** Discard without reading. */
  clear: () => void;
}

/** A draft older than this is dropped by consumer `useEffect`s. */
export const DRAFT_TTL_MS = 5 * 60 * 1000;

export const useAiDraftStore = create<AiDraftState>((set, get) => ({
  draft: null,

  setDraft: (input) => {
    set({
      draft: {
        prompt: input.prompt,
        contextPaths: [...new Set(input.contextPaths)],
        source: input.source,
        createdAt: Date.now(),
      },
    });
  },

  consume: () => {
    const current = get().draft;
    set({ draft: null });
    return current;
  },

  clear: () => set({ draft: null }),
}));
