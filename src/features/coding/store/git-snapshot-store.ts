import { create } from "zustand";

import {
  codingGitSnapshot,
  type CodingGitFile,
  type CodingGitSnapshot,
} from "@/lib/agent-client";

interface GitSnapshotState {
  snapshot: CodingGitSnapshot | null;
  /** Relative-posix path (under workspace root) → file status. */
  byPath: Map<string, CodingGitFile>;
  loading: boolean;
  error: string | null;
  /** Unix ms of the last successful fetch (used to debounce calls). */
  lastFetched: number;
  refresh(root: string): Promise<void>;
  clear(): void;
}

const EMPTY_MAP: Map<string, CodingGitFile> = new Map();
// SP5: 300 ms → 500 ms. Reduces git status spam on large repos.
const MIN_REFRESH_GAP_MS = 500;

function indexByPath(snapshot: CodingGitSnapshot | null): Map<string, CodingGitFile> {
  if (!snapshot) return EMPTY_MAP;
  const map = new Map<string, CodingGitFile>();
  for (const file of snapshot.files) {
    map.set(file.path.replace(/\\/g, "/"), file);
  }
  return map;
}

export const useGitSnapshotStore = create<GitSnapshotState>((set, get) => ({
  snapshot: null,
  byPath: EMPTY_MAP,
  loading: false,
  error: null,
  lastFetched: 0,

  refresh: async (root: string) => {
    if (!root) {
      set({ snapshot: null, byPath: EMPTY_MAP, error: null, loading: false });
      return;
    }
    const now = Date.now();
    const { lastFetched, loading } = get();
    if (loading) return;
    if (now - lastFetched < MIN_REFRESH_GAP_MS) return;
    set({ loading: true, error: null });
    try {
      const snapshot = await codingGitSnapshot(root);
      set({
        snapshot,
        byPath: indexByPath(snapshot),
        loading: false,
        error: null,
        lastFetched: now,
      });
    } catch (error) {
      const message = String(error).replace(/^Error:\s*/, "");
      set({ loading: false, error: message });
    }
  },

  clear: () => set({ snapshot: null, byPath: EMPTY_MAP, error: null, loading: false, lastFetched: 0 }),
}));

/**
 * Helper to look up the status for a workspace-relative path. Returns
 * `undefined` when the file isn't tracked.
 */
export function lookupGitStatus(
  byPath: Map<string, CodingGitFile>,
  absolutePath: string,
  workspaceRelative: (absolute: string) => string | null,
): CodingGitFile | undefined {
  const rel = workspaceRelative(absolutePath);
  if (!rel) return undefined;
  return byPath.get(rel.replace(/\\/g, "/"));
}
