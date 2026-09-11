import { create } from "zustand";

/** Virtual document tabs produced by the workbench rather than the filesystem. */
export type DocTabKind = "delivery" | "taskDag" | "profile";

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
}

export interface DocTab {
  type: "doc";
  id: string;
  kind: DocTabKind;
  title: string;
}

export type WorkbenchTab = FileTab | DocTab;

const DOC_TITLES: Record<DocTabKind, string> = {
  delivery: "交付报告",
  taskDag: "任务进度",
  profile: "工程画像",
};

interface TabState {
  tabs: WorkbenchTab[];
  activeId: string | null;
  openFile: (tab: Omit<FileTab, "type" | "view"> & { view?: FileTab["view"] }) => void;
  openDoc: (kind: DocTabKind) => void;
  closeTab: (id: string) => void;
  closeAll: () => void;
  setActive: (id: string) => void;
  updateDraft: (id: string, draft: string) => void;
  setView: (id: string, view: FileTab["view"]) => void;
  markSaved: (id: string, original: string, hash: string) => void;
  markConflict: (id: string) => void;
  setError: (id: string, error?: string) => void;
}

export function isFileTab(tab: WorkbenchTab): tab is FileTab {
  return tab.type === "file";
}

/** A tab whose draft differs from disk. */
export function isDirty(tab: WorkbenchTab): boolean {
  return isFileTab(tab) && tab.draft !== tab.original;
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

  setView: (id, view) =>
    set((state) => ({
      tabs: state.tabs.map((tab) => (tab.id === id && isFileTab(tab) ? { ...tab, view } : tab)),
    })),

  markSaved: (id, original, hash) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === id && isFileTab(tab)
          ? { ...tab, original, draft: original, hash, conflict: false, error: undefined }
          : tab,
      ),
    })),

  markConflict: (id) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === id && isFileTab(tab) ? { ...tab, conflict: true } : tab,
      ),
    })),

  setError: (id, error) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === id && isFileTab(tab) ? { ...tab, error, loading: false } : tab,
      ),
    })),
}));
