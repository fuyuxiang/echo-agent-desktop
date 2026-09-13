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

// 46px activity rail + two 4px separators. Keep a useful editor surface even
// when large pane widths were persisted on a larger display.
const FIXED_HORIZONTAL_CHROME = 54;
const MAIN_MIN_WIDTH = 260;
// 44px top bar + 22px status bar. The remainder is shared by editor and tools.
const FIXED_VERTICAL_CHROME = 66;
const MAIN_MIN_HEIGHT = 260;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export interface EffectiveWorkbenchLayout {
  explorerWidth: number;
  agentWidth: number;
  bottomHeight: number;
}

/**
 * Fit persisted preferences into the current workbench without overwriting
 * them. Resizing the window smaller temporarily contracts both side panes and
 * the bottom panel; expanding it restores the user's preferred dimensions.
 */
export function fitWorkbenchLayout(
  containerWidth: number,
  containerHeight: number,
  preferred: EffectiveWorkbenchLayout,
): EffectiveWorkbenchLayout {
  const desiredExplorer = clamp(preferred.explorerWidth, EXPLORER_MIN, EXPLORER_MAX);
  const desiredAgent = clamp(preferred.agentWidth, AGENT_MIN, AGENT_MAX);
  const desiredBottom = clamp(preferred.bottomHeight, BOTTOM_MIN, BOTTOM_MAX);

  let explorerWidth = desiredExplorer;
  let agentWidth = desiredAgent;

  if (Number.isFinite(containerWidth) && containerWidth > 0) {
    const paneBudget = Math.max(0, Math.floor(
      containerWidth - FIXED_HORIZONTAL_CHROME - MAIN_MIN_WIDTH,
    ));
    const minimumPaneTotal = EXPLORER_MIN + AGENT_MIN;
    const desiredPaneTotal = desiredExplorer + desiredAgent;

    if (paneBudget < minimumPaneTotal) {
      // This only applies below the native window's supported minimum width,
      // but keeps browser/dev rendering free of horizontal overflow as well.
      explorerWidth = Math.round(paneBudget * (EXPLORER_MIN / minimumPaneTotal));
      agentWidth = Math.max(0, paneBudget - explorerWidth);
    } else if (paneBudget < desiredPaneTotal) {
      const availableExtra = paneBudget - minimumPaneTotal;
      const explorerExtra = desiredExplorer - EXPLORER_MIN;
      const agentExtra = desiredAgent - AGENT_MIN;
      const desiredExtra = explorerExtra + agentExtra;
      const explorerShare = desiredExtra > 0
        ? Math.round(availableExtra * (explorerExtra / desiredExtra))
        : 0;
      explorerWidth = EXPLORER_MIN + explorerShare;
      agentWidth = AGENT_MIN + availableExtra - explorerShare;
    }
  }

  const bottomBudget = Number.isFinite(containerHeight) && containerHeight > 0
    ? Math.max(0, Math.floor(containerHeight - FIXED_VERTICAL_CHROME - MAIN_MIN_HEIGHT))
    : desiredBottom;

  return {
    explorerWidth,
    agentWidth,
    bottomHeight: Math.min(desiredBottom, bottomBudget),
  };
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
