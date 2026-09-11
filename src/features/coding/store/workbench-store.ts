import { create } from "zustand";

import type { VerificationKind } from "../lib/types";

/** Activity bar destinations. */
export type ActivityView = "files" | "search" | "changes" | "symbols" | "context";
/** Bottom panel tabs. */
export type BottomView = "terminal" | "problems" | "tests" | "output" | "trace";

export const WORKBENCH_LAYOUT_KEY = "echo-coding-workbench-layout";

const EXPLORER_MIN = 180;
const EXPLORER_MAX = 520;
const AGENT_MIN = 300;
const AGENT_MAX = 720;
const BOTTOM_MIN = 120;
const BOTTOM_MAX = 720;

const DEFAULTS = {
  explorerWidth: 238,
  agentWidth: 380,
  bottomHeight: 220,
};

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

interface LayoutState {
  explorerWidth: number;
  agentWidth: number;
  bottomHeight: number;
  bottomOpen: boolean;
  activityView: ActivityView;
  bottomView: BottomView;
}

interface WorkbenchState extends LayoutState {
  setExplorerWidth: (value: number) => void;
  setAgentWidth: (value: number) => void;
  setBottomHeight: (value: number) => void;
  toggleBottom: (open?: boolean) => void;
  setActivityView: (view: ActivityView) => void;
  setBottomView: (view: BottomView) => void;
  hydrateLayout: () => void;
  resetLayout: () => void;
}

/**
 * Persist only pane geometry. Task state is owned by the Rust backend, so this
 * store deliberately holds nothing that would be lost if storage is cleared.
 */
function persist(state: LayoutState): void {
  try {
    localStorage.setItem(
      WORKBENCH_LAYOUT_KEY,
      JSON.stringify({
        explorerWidth: state.explorerWidth,
        agentWidth: state.agentWidth,
        bottomHeight: state.bottomHeight,
      }),
    );
  } catch {
    // Storage may be disabled; the session keeps working with in-memory layout.
  }
}

export const useWorkbenchStore = create<WorkbenchState>((set, get) => ({
  ...DEFAULTS,
  bottomOpen: false,
  activityView: "files",
  bottomView: "problems",

  setExplorerWidth: (value) => {
    set({ explorerWidth: clamp(value, EXPLORER_MIN, EXPLORER_MAX) });
    persist(get());
  },
  setAgentWidth: (value) => {
    set({ agentWidth: clamp(value, AGENT_MIN, AGENT_MAX) });
    persist(get());
  },
  setBottomHeight: (value) => {
    set({ bottomHeight: clamp(value, BOTTOM_MIN, BOTTOM_MAX) });
    persist(get());
  },
  toggleBottom: (open) => set((state) => ({ bottomOpen: open ?? !state.bottomOpen })),
  setActivityView: (activityView) => set({ activityView }),
  setBottomView: (bottomView) => set({ bottomView, bottomOpen: true }),

  hydrateLayout: () => {
    try {
      const raw = localStorage.getItem(WORKBENCH_LAYOUT_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<LayoutState>;
      set({
        explorerWidth: clamp(
          parsed.explorerWidth ?? DEFAULTS.explorerWidth,
          EXPLORER_MIN,
          EXPLORER_MAX,
        ),
        agentWidth: clamp(parsed.agentWidth ?? DEFAULTS.agentWidth, AGENT_MIN, AGENT_MAX),
        bottomHeight: clamp(parsed.bottomHeight ?? DEFAULTS.bottomHeight, BOTTOM_MIN, BOTTOM_MAX),
      });
    } catch {
      // A corrupt entry must not stop the workbench from opening.
    }
  },
  resetLayout: () =>
    set({ ...DEFAULTS, bottomOpen: false, activityView: "files", bottomView: "problems" }),
}));

/** Label shown for a verification kind in the tests panel. */
export function verificationLabel(kind: VerificationKind): string {
  switch (kind) {
    case "build":
      return "构建";
    case "lint":
      return "静态检查";
    case "type_check":
      return "类型检查";
    case "test":
      return "测试";
    default:
      return "命令";
  }
}
