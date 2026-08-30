export type CatalogRootKind = "experts" | "skills" | "connectors";

const ROOT_KEYS: Record<CatalogRootKind, { current: string; legacy: string }> = {
  experts: {
    current: "echoagent.catalog.experts-root.v1",
    legacy: "expertsRoot",
  },
  skills: {
    current: "echoagent.catalog.skills-root.v1",
    legacy: "skillsCatalogRoot",
  },
  connectors: {
    current: "echoagent.catalog.connectors-root.v1",
    legacy: "connectorsRoot",
  },
};

function availableStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * Old EchoAgent builds persisted marketplace roots owned by WorkBuddy. Keep
 * this check cross-platform because the same localStorage migration also runs
 * in Windows WebView2 builds.
 */
export function isLegacyWorkBuddyPath(path: string): boolean {
  return path
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .some((part) => {
      const normalized = part.toLowerCase();
      return normalized === ".workbuddy" || normalized === "workbuddy";
    });
}

export function clearCatalogRoot(kind: CatalogRootKind): void {
  const storage = availableStorage();
  if (!storage) return;
  const keys = ROOT_KEYS[kind];
  try {
    storage.removeItem(keys.current);
    storage.removeItem(keys.legacy);
  } catch {
    // A disabled or full WebView storage must not block catalog loading.
  }
}

/** Read the namespaced root and migrate the old generic key once. */
export function readCatalogRoot(kind: CatalogRootKind): string {
  const storage = availableStorage();
  if (!storage) return "";
  const keys = ROOT_KEYS[kind];

  try {
    const current = (storage.getItem(keys.current) || "").trim();
    if (current && !isLegacyWorkBuddyPath(current)) {
      storage.removeItem(keys.legacy);
      return current;
    }
    if (current) storage.removeItem(keys.current);

    const legacy = (storage.getItem(keys.legacy) || "").trim();
    storage.removeItem(keys.legacy);
    if (!legacy || isLegacyWorkBuddyPath(legacy)) return "";

    storage.setItem(keys.current, legacy);
    return legacy;
  } catch {
    return "";
  }
}

export function writeCatalogRoot(kind: CatalogRootKind, path: string): boolean {
  const storage = availableStorage();
  const normalized = path.trim();
  if (!storage || !normalized || isLegacyWorkBuddyPath(normalized)) {
    clearCatalogRoot(kind);
    return false;
  }

  const keys = ROOT_KEYS[kind];
  try {
    storage.setItem(keys.current, normalized);
    storage.removeItem(keys.legacy);
    return true;
  } catch {
    return false;
  }
}

/** Purge/migrate all historical keys even when their feature tabs are unopened. */
export function migrateCatalogRootStorage(): void {
  (Object.keys(ROOT_KEYS) as CatalogRootKind[]).forEach(readCatalogRoot);
}
