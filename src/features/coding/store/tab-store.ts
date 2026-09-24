import { create } from "zustand";

import type { EditorCodeContext } from "../lib/documentation";

/** Virtual document tabs produced by the workbench rather than the filesystem. */
export type DocTabKind = "delivery" | "taskDag" | "profile";

/**
 * Phase 2 virtual tabs. Each kind takes a `SymbolKey` as `params` so
 * re-opening the same symbol focuses the existing tab instead of stacking
 * duplicates.
 */
export type VirtualTabKind = "findReferences" | "impactAnalysis" | "goToDefinition";

export interface SymbolKey {
  /** Symbol name — the dedup key. */
  name: string;
  file?: string;
  line?: number;
}

export interface FileTab {
  type: "file";
  /** Absolute path; also the tab's id. */
  id: string;
  relativePath: string;
  name: string;
  language: string;
  /** Content as it exists on disk. */
  original: string;
  /** Content in the editor, which may be ahead of disk. */
  draft: string;
  /** Disk hash captured at load, used for conflict detection on save. */
  hash: string;
  view: "edit" | "diff";
  loading: boolean;
  error?: string;
  /** Another writer changed the file after we loaded it. */
  conflict?: boolean;
  /** Task-baseline content used by the review diff, independent of editor load time. */
  diffOriginal?: string;
  diffModified?: string;
  diffBinary?: boolean;
  diffHash?: string;
  /** The task that produced the cached review diff. */
  diffTaskId?: string;
}

export interface DocTab {
  type: "doc";
  id: string;
  kind: DocTabKind;
  title: string;
}

export interface VirtualTab {
  type: "virtual";
  id: string;
  kind: VirtualTabKind;
  title: string;
  /** Identifies which symbol the tab is bound to. */
  symbol: SymbolKey;
  /** Workspace root the analysis was started against. */
  root: string;
}

export type WorkbenchTab = FileTab | DocTab | VirtualTab;

export type FileLoadSnapshot = Pick<
  FileTab,
  "relativePath" | "language" | "original" | "draft" | "hash"
>;

const DOC_TITLES: Record<DocTabKind, string> = {
  delivery: "交付报告",
  taskDag: "任务进度",
  profile: "工程画像",
};

const VIRTUAL_TITLES: Record<VirtualTabKind, string> = {
  findReferences: "查找引用",
  impactAnalysis: "影响范围",
  goToDefinition: "跳转到定义",
};

interface TabState {
  tabs: WorkbenchTab[];
  activeId: string | null;
  openFile: (tab: Omit<FileTab, "type" | "view"> & { view?: FileTab["view"] }) => void;
  openDoc: (kind: DocTabKind) => void;
  openVirtual: (kind: VirtualTabKind, root: string, symbol: SymbolKey) => void;
  closeTab: (id: string) => void;
  closeAll: () => void;
  setActive: (id: string) => void;
  updateDraft: (id: string, draft: string) => void;
  setLanguage: (id: string, language: string) => void;
  setView: (id: string, view: FileTab["view"]) => void;
  setDiff: (
    id: string,
    original: string,
    modified: string,
    binary?: boolean,
    taskId?: string,
    diffHash?: string,
  ) => void;
  clearDiff: (id: string) => void;
  beginFileLoad: (id: string) => void;
  completeFileLoad: (id: string, document: FileLoadSnapshot) => void;
  markSaved: (id: string, original: string, hash: string) => void;
  markConflict: (id: string) => void;
  clearConflict: (id: string) => void;
  setError: (id: string, error?: string) => void;
  /** SP1: rename a file tab id (when the underlying file is renamed). */
  renameTab: (oldId: string, newId: string) => void;
}

export function isFileTab(tab: WorkbenchTab): tab is FileTab {
  return tab.type === "file";
}

export function isVirtualTab(tab: WorkbenchTab): tab is VirtualTab {
  return tab.type === "virtual";
}

/** Resolve a file read while retaining view/diff metadata owned by the tab. */
export function completeFileTabLoad(tab: FileTab, document: FileLoadSnapshot): FileTab {
  return {
    ...tab,
    ...document,
    loading: false,
    error: undefined,
    conflict: false,
  };
}

/** A tab whose draft differs from disk. */
export function isDirty(tab: WorkbenchTab): boolean {
  return isFileTab(tab) && tab.draft !== tab.original;
}

/**
 * Per-workspace UI state retained across tab switches so each project keeps
 * its own tab set, editor context, and minimap visibility.
 *
 * Tree expansion lives in `treeExpandedPathsRef` and cut/copy markers live
 * in `useClipboardStore`; neither is part of this record.
 */
export interface WorkspaceUiState {
  tabs: WorkbenchTab[];
  activeId: string | null;
  contextPaths: string[];
  editorContext: EditorCodeContext | null;
  selectedDirectory: string;
  minimapEnabled: boolean;
}

/** The minimap is visible by default and can be hidden per workspace. */
export const DEFAULT_MINIMAP_ENABLED = true;

function virtualTabId(kind: VirtualTabKind, symbol: SymbolKey): string {
  return `virtual:${kind}:${symbol.name}`;
}

export const useTabStore = create<TabState>((set, get) => ({
  tabs: [],
  activeId: null,

  openFile: (tab) => {
    const existing = get().tabs.find((entry) => entry.id === tab.id);
    if (existing) {
      // Re-opening a file must not discard unsaved edits.
      set({ activeId: tab.id });
      return;
    }
    set((state) => ({
      tabs: [...state.tabs, { ...tab, type: "file", view: tab.view ?? "edit" }],
      activeId: tab.id,
    }));
  },

  openDoc: (kind) => {
    const id = `doc:${kind}`;
    const existing = get().tabs.find((entry) => entry.id === id);
    if (existing) {
      set({ activeId: id });
      return;
    }
    set((state) => ({
      tabs: [...state.tabs, { type: "doc", id, kind, title: DOC_TITLES[kind] }],
      activeId: id,
    }));
  },

  openVirtual: (kind, root, symbol) => {
    const id = virtualTabId(kind, symbol);
    const existing = get().tabs.find((entry) => entry.id === id);
    if (existing) {
      set({ activeId: id });
      return;
    }
    set((state) => ({
      tabs: [
        ...state.tabs,
        {
          type: "virtual",
          id,
          kind,
          title: `${VIRTUAL_TITLES[kind]} · ${symbol.name}`,
          root,
          symbol,
        },
      ],
      activeId: id,
    }));
  },

  closeTab: (id) =>
    set((state) => {
      const index = state.tabs.findIndex((entry) => entry.id === id);
      if (index < 0) return state;
      const tabs = state.tabs.filter((entry) => entry.id !== id);
      if (state.activeId !== id) return { ...state, tabs };
      // Focus the neighbour that visually takes this tab's place.
      const next = tabs[index] ?? tabs[index - 1] ?? null;
      return { tabs, activeId: next?.id ?? null };
    }),

  closeAll: () => set({ tabs: [], activeId: null }),
  setActive: (activeId) => set({ activeId }),

  updateDraft: (id, draft) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === id && isFileTab(tab) ? { ...tab, draft } : tab,
      ),
    })),

  setLanguage: (id, language) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === id && isFileTab(tab) ? { ...tab, language } : tab,
      ),
    })),

  setView: (id, view) =>
    set((state) => ({
      tabs: state.tabs.map((tab) => (tab.id === id && isFileTab(tab) ? { ...tab, view } : tab)),
    })),

  setDiff: (id, diffOriginal, diffModified, diffBinary = false, diffTaskId, diffHash) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === id && isFileTab(tab)
          ? {
              ...tab,
              diffOriginal,
              diffModified,
              diffBinary,
              diffTaskId,
              diffHash,
              view: "diff",
              loading: false,
              error: undefined,
            }
          : tab,
      ),
    })),

  clearDiff: (id) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === id && isFileTab(tab)
          ? {
              ...tab,
              view: "edit",
              diffOriginal: undefined,
              diffModified: undefined,
              diffBinary: undefined,
              diffTaskId: undefined,
              diffHash: undefined,
            }
          : tab,
      ),
    })),

  beginFileLoad: (id) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === id && isFileTab(tab)
          ? { ...tab, loading: true, error: undefined }
          : tab,
      ),
    })),

  completeFileLoad: (id, document) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === id && isFileTab(tab)
          ? completeFileTabLoad(tab, document)
          : tab,
      ),
    })),

  markSaved: (id, original, hash) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === id && isFileTab(tab)
          ? {
              ...tab,
              original,
              draft: original,
              hash,
              loading: false,
              conflict: false,
              error: undefined,
            }
          : tab,
      ),
    })),

  markConflict: (id) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === id && isFileTab(tab) ? { ...tab, conflict: true } : tab,
      ),
    })),

  clearConflict: (id) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === id && isFileTab(tab)
          ? { ...tab, conflict: false, error: undefined }
          : tab,
      ),
    })),

  setError: (id, error) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === id && isFileTab(tab) ? { ...tab, error, loading: false } : tab,
      ),
    })),

  renameTab: (oldId, newId) =>
    set((state) => {
      const oldNormalized = oldId.replace(/\\/g, "/").replace(/\/+$/, "");
      let renamed = false;
      const tabs = state.tabs.map((tab) => {
        if (!isFileTab(tab)) return tab;
        const normalized = tab.id.replace(/\\/g, "/");
        if (normalized !== oldNormalized && !normalized.startsWith(`${oldNormalized}/`)) return tab;
        renamed = true;
        const suffix = normalized.slice(oldNormalized.length);
        const id = `${newId.replace(/[\\/]+$/, "")}${suffix}`;
        const normalizedId = id.replace(/\\/g, "/");
        const normalizedRelative = tab.relativePath.replace(/\\/g, "/");
        const workspacePrefixLength = normalized.endsWith(normalizedRelative)
          ? normalized.length - normalizedRelative.length
          : -1;
        return {
          ...tab,
          id,
          name: normalizedId.split("/").pop() ?? tab.name,
          relativePath: workspacePrefixLength >= 0
            ? normalizedId.slice(workspacePrefixLength)
            : suffix === ""
              ? tab.relativePath.replace(/[^/\\]+$/, normalizedId.split("/").pop() ?? tab.name)
              : tab.relativePath,
        };
      });
      if (!renamed) return state;
      const active = state.activeId?.replace(/\\/g, "/");
      const activeId = active && (active === oldNormalized || active.startsWith(`${oldNormalized}/`))
        ? `${newId.replace(/[\\/]+$/, "")}${active.slice(oldNormalized.length)}`
        : state.activeId;
      return { tabs, activeId };
    }),
}));
