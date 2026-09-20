import { isDirty, type WorkbenchTab } from "../store/tab-store";

const KEY_PREFIX = "echo-coding-hot-exit-v1:";
const MAX_BYTES = 3 * 1024 * 1024;

export interface CodingHotExitState {
  version: 1;
  root: string;
  tabs: WorkbenchTab[];
  activeId: string | null;
  selectedDirectory: string;
  expandedPaths: string[];
  savedAt: number;
}

function key(root: string): string {
  return `${KEY_PREFIX}${encodeURIComponent(root)}`;
}

function validTab(value: unknown): value is WorkbenchTab {
  if (!value || typeof value !== "object") return false;
  const tab = value as Partial<WorkbenchTab>;
  if (typeof tab.id !== "string") return false;
  if (tab.type === "file") {
    const file = tab as Partial<Extract<WorkbenchTab, { type: "file" }>>;
    return typeof file.relativePath === "string"
      && typeof file.name === "string"
      && typeof file.language === "string"
      && typeof file.original === "string"
      && typeof file.draft === "string"
      && typeof file.hash === "string"
      && (file.view === "edit" || file.view === "diff")
      && typeof file.loading === "boolean";
  }
  if (tab.type === "doc") {
    return typeof tab.title === "string"
      && ["delivery", "taskDag", "profile"].includes(tab.kind ?? "");
  }
  if (tab.type === "virtual") {
    return typeof tab.title === "string"
      && typeof tab.root === "string"
      && Boolean(tab.symbol)
      && typeof tab.symbol?.name === "string"
      && ["findReferences", "impactAnalysis", "goToDefinition"].includes(tab.kind ?? "");
  }
  return false;
}

function isInsideRoot(path: string, root: string): boolean {
  const normalizedPath = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

function serializedBytes(value: string): number {
  return typeof TextEncoder === "undefined"
    ? value.length * 2
    : new TextEncoder().encode(value).byteLength;
}

export function loadCodingHotExit(root: string): CodingHotExitState | null {
  if (!root) return null;
  try {
    const parsed = JSON.parse(localStorage.getItem(key(root)) ?? "null") as Partial<CodingHotExitState> | null;
    if (!parsed || parsed.version !== 1 || parsed.root !== root || !Array.isArray(parsed.tabs)) return null;
    const tabs = parsed.tabs
      .filter(validTab)
      .filter((tab) => tab.type !== "file" || isInsideRoot(tab.id, root))
      .slice(0, 200);
    const selectedDirectory = typeof parsed.selectedDirectory === "string"
      && isInsideRoot(parsed.selectedDirectory, root)
      ? parsed.selectedDirectory
      : root;
    return {
      version: 1,
      root,
      tabs,
      activeId: tabs.some((tab) => tab.id === parsed.activeId) ? parsed.activeId ?? null : tabs[0]?.id ?? null,
      selectedDirectory,
      expandedPaths: Array.isArray(parsed.expandedPaths)
        ? parsed.expandedPaths
          .filter((path): path is string => typeof path === "string" && isInsideRoot(path, root))
          .slice(0, 512)
        : [],
      savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Persist the workbench for crash/restart recovery. If the browser quota would
 * be exceeded, clean file buffers are dropped first; unsaved drafts always get
 * priority because their content cannot be reconstructed from disk.
 */
export function saveCodingHotExit(state: CodingHotExitState): void {
  if (!state.root) return;
  try {
    let serialized = JSON.stringify(state);
    if (serializedBytes(serialized) > MAX_BYTES) {
      const essentialTabs = state.tabs.filter((tab) => tab.type !== "file" || isDirty(tab));
      serialized = JSON.stringify({ ...state, tabs: essentialTabs });
    }
    if (serializedBytes(serialized) > MAX_BYTES) return;
    localStorage.setItem(key(state.root), serialized);
  } catch {
    // A disabled/full webview store must not interrupt editing.
  }
}

export function codingTaskDraftKey(root: string): string {
  return `${KEY_PREFIX}task-draft:${encodeURIComponent(root)}`;
}
