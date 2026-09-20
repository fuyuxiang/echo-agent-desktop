/**
 * Bounded recursive file index for quick-open.
 *
 * `list_dir` is non-recursive, so the palette builds its own index. The walk is
 * breadth-first and capped on both entries and depth: a monorepo must not stall
 * the palette, and a partial index that appears immediately is more useful than
 * a complete one that arrives late.
 */

import { listDir } from "@/lib/agent-client";

const MAX_FILES = 20_000;
const MAX_DEPTH = 12;
const IGNORED = new Set([
  ".git",
  "node_modules",
  "target",
  "dist",
  "build",
  ".next",
  ".venv",
  "venv",
  "__pycache__",
  ".gradle",
  ".idea",
  ".vscode",
  "vendor",
]);

export interface FileIndexResult {
  /** Workspace-relative, forward-slashed paths. */
  paths: string[];
  /** True when a cap stopped the walk before it finished. */
  truncated: boolean;
}

function normalizedRelative(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
}

/**
 * Apply a watcher event to the quick-open index without rescanning the whole
 * repository. A removal may represent a directory, so descendants are removed
 * as well. The returned list remains sorted and duplicate-free.
 */
export function applyFileIndexEvent(
  paths: string[],
  changedPath: string,
  removed: boolean,
): string[] {
  const changed = normalizedRelative(changedPath);
  if (!changed) return paths;
  if (removed) {
    const prefix = `${changed}/`;
    const next = paths.filter((path) => {
      const normalized = normalizedRelative(path);
      return normalized !== changed && !normalized.startsWith(prefix);
    });
    return next.length === paths.length ? paths : next;
  }
  if (paths.some((path) => normalizedRelative(path) === changed)) return paths;
  return [...paths, changed].sort();
}

function relative(root: string, absolute: string): string {
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalized = absolute.replace(/\\/g, "/");
  return normalized.startsWith(`${normalizedRoot}/`)
    ? normalized.slice(normalizedRoot.length + 1)
    : normalized;
}

/**
 * Walk the workspace and collect file paths.
 *
 * `onProgress` is called as batches arrive so the palette can render a usable
 * list while the rest of the tree is still being read. `signal` lets a workspace
 * switch abandon an in-flight walk.
 */
export async function buildFileIndex(
  root: string,
  options: {
    onProgress?: (paths: string[]) => void;
    signal?: { aborted: boolean };
  } = {},
): Promise<FileIndexResult> {
  if (!root) return { paths: [], truncated: false };

  const paths: string[] = [];
  let truncated = false;
  let queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];

  while (queue.length > 0) {
    if (options.signal?.aborted) break;
    if (paths.length >= MAX_FILES) {
      truncated = true;
      break;
    }

    const next: Array<{ path: string; depth: number }> = [];
    // Read one depth level per round so progress arrives in useful chunks.
    for (const entry of queue) {
      if (options.signal?.aborted) break;
      if (paths.length >= MAX_FILES) {
        truncated = true;
        break;
      }
      let entries;
      try {
        entries = await listDir(entry.path, root);
      } catch {
        // An unreadable directory is skipped rather than failing the whole index.
        continue;
      }
      for (const child of entries) {
        if (child.kind === "directory") {
          if (entry.depth + 1 <= MAX_DEPTH && !IGNORED.has(child.name) && !child.name.startsWith(".")) {
            next.push({ path: child.path, depth: entry.depth + 1 });
          }
          continue;
        }
        if (child.kind !== "file") continue;
        paths.push(relative(root, child.path));
        if (paths.length >= MAX_FILES) {
          truncated = true;
          break;
        }
      }
    }

    if (paths.length > 0) options.onProgress?.([...paths]);
    queue = next;
  }

  paths.sort();
  return { paths, truncated };
}
