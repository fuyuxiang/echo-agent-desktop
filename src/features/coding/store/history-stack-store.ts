import { create } from "zustand";

/**
 * In-memory undo / redo stack for the six core file operations.
 *
 * Each entry stores only the metadata required to reverse the operation (paths,
 * basenames, original locations) — never file contents — so the stack stays
 * cheap regardless of payload size. The lifetime is one coding session:
 * closing the window discards everything, mirroring VSCode / JetBrains.
 *
 * The stack is also bounded to `MAX_HISTORY` entries to keep memory usage
 * predictable during long editing sessions; when the cap is hit, the oldest
 * entry is dropped silently.
 */

export const MAX_HISTORY = 50;

export type HistoryOp =
  | {
      op: "rename";
      cwd: string;
      /** New (post-rename) absolute path. */
      path: string;
      /** Basename to restore on undo. */
      oldBasename: string;
    }
  | {
      op: "delete";
      cwd: string;
      originalPaths: string[];
      trashBasenames: string[];
    }
  | {
      op: "copy";
      cwd: string;
      /** Absolute paths of newly created copies. */
      createdPaths: string[];
    }
  | {
      op: "move";
      cwd: string;
      paths: string[];
      sourceParent: string;
    }
  | {
      op: "create";
      cwd: string;
      path: string;
      isDir: boolean;
    }
  | {
      op: "paste";
      cwd: string;
      mode: "cut" | "copy";
      finalPaths: string[];
      sourceParent: string;
    };

interface HistoryState {
  past: HistoryOp[];
  future: HistoryOp[];
  push: (op: HistoryOp) => void;
  undo: () => HistoryOp | null;
  redo: () => HistoryOp | null;
  clear: () => void;
}

export const useHistoryStackStore = create<HistoryState>((set, get) => ({
  past: [],
  future: [],

  push: (op) => {
    set((state) => ({
      past: [...state.past, op].slice(-MAX_HISTORY),
      future: [], // a fresh action invalidates the redo stack
    }));
  },

  undo: () => {
    const { past, future } = get();
    if (past.length === 0) return null;
    const entry = past[past.length - 1];
    set({
      past: past.slice(0, -1),
      future: [...future, entry],
    });
    return entry;
  },

  redo: () => {
    const { past, future } = get();
    if (future.length === 0) return null;
    const entry = future[future.length - 1];
    set({
      past: [...past, entry],
      future: future.slice(0, -1),
    });
    return entry;
  },

  clear: () => set({ past: [], future: [] }),
}));

/** Human-readable label for a history op (used by the right-click menu). */
export function humanOpLabel(op: HistoryOp["op"]): string {
  switch (op) {
    case "rename":
      return "重命名";
    case "delete":
      return "删除";
    case "copy":
      return "复制";
    case "move":
      return "移动";
    case "create":
      return "新建";
    case "paste":
      return "粘贴";
  }
}
