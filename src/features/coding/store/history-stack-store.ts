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

export interface TrashedPath {
  path: string;
  restoreToken: string;
}

export interface MovedPath {
  sourcePath: string;
  finalPath: string;
}

export type HistoryOp =
  | {
      op: "rename";
      cwd: string;
      oldPath: string;
      newPath: string;
    }
  | {
      op: "delete";
      cwd: string;
      items: TrashedPath[];
    }
  | {
      op: "copy";
      cwd: string;
      sources: string[];
      destination: string;
      createdPaths: string[];
      trashedCopies?: TrashedPath[];
    }
  | {
      op: "move";
      cwd: string;
      destination: string;
      moves: MovedPath[];
    }
  | {
      op: "create";
      cwd: string;
      path: string;
      isDir: boolean;
      trashedItem?: TrashedPath;
    }
  | {
      op: "paste";
      cwd: string;
      mode: "cut" | "copy";
      sources: string[];
      destination: string;
      finalPaths: string[];
      trashedCopies?: TrashedPath[];
    };

interface HistoryState {
  past: HistoryOp[];
  future: HistoryOp[];
  push: (op: HistoryOp) => void;
  peekUndo: (cwd: string) => HistoryOp | null;
  peekRedo: (cwd: string) => HistoryOp | null;
  commitUndo: (cwd: string, updated?: HistoryOp) => void;
  commitRedo: (cwd: string, updated?: HistoryOp) => void;
  clear: () => void;
}

function lastWorkspaceIndex(entries: HistoryOp[], cwd: string): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.cwd === cwd) return index;
  }
  return -1;
}

export const useHistoryStackStore = create<HistoryState>((set, get) => ({
  past: [],
  future: [],

  push: (op) => {
    set((state) => ({
      past: [...state.past, op].slice(-MAX_HISTORY),
      // A fresh action invalidates redo only in the same project. Other
      // recently opened projects retain their independent editing history.
      future: state.future.filter((entry) => entry.cwd !== op.cwd),
    }));
  },

  peekUndo: (cwd) => {
    const { past } = get();
    const index = lastWorkspaceIndex(past, cwd);
    return index < 0 ? null : past[index];
  },

  peekRedo: (cwd) => {
    const { future } = get();
    const index = lastWorkspaceIndex(future, cwd);
    return index < 0 ? null : future[index];
  },

  commitUndo: (cwd, updated) => {
    const { past, future } = get();
    const index = lastWorkspaceIndex(past, cwd);
    if (index < 0) return;
    const entry = updated ?? past[index];
    set({
      past: past.filter((_, entryIndex) => entryIndex !== index),
      future: [...future, entry].slice(-MAX_HISTORY),
    });
  },

  commitRedo: (cwd, updated) => {
    const { past, future } = get();
    const index = lastWorkspaceIndex(future, cwd);
    if (index < 0) return;
    const entry = updated ?? future[index];
    set({
      past: [...past, entry].slice(-MAX_HISTORY),
      future: future.filter((_, entryIndex) => entryIndex !== index),
    });
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
