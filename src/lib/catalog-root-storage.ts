export type CatalogRootKind = "experts" | "skills" | "connectors";

const ROOT_KEYS: Record<CatalogRootKind, { current: string; deprecated: string[] }> = {
  experts: {
    current: "echoagent.catalog.experts-root.v2",
    deprecated: ["echoagent.catalog.experts-root.v1", "expertsRoot"],
  },
  skills: {
    current: "echoagent.catalog.skills-root.v2",
    deprecated: ["echoagent.catalog.skills-root.v1", "skillsCatalogRoot"],
  },
  connectors: {
    current: "echoagent.catalog.connectors-root.v2",
    deprecated: ["echoagent.catalog.connectors-root.v1", "connectorsRoot"],
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
    keys.deprecated.forEach((key) => storage.removeItem(key));
  } catch {
    // A disabled or full WebView storage must not block catalog loading.
  }
}

/**
 * Read an explicit user-selected catalog root.
 *
 * v1 cannot be migrated safely: older panels persisted both automatic
 * defaults and manual overrides under the same key. Retaining it could pin a
 * new build to `~/.echo-agent` after `ECHO_AGENT_HOME` changes, so v1 and the
 * original generic keys are removed once. The backend default is then
 * resolved from the active EchoAgent data home.
 */
export function readCatalogRoot(kind: CatalogRootKind): string {
  const storage = availableStorage();
  if (!storage) return "";
  const keys = ROOT_KEYS[kind];

  try {
    const current = (storage.getItem(keys.current) || "").trim();
    if (current && !isLegacyWorkBuddyPath(current)) {
      keys.deprecated.forEach((key) => storage.removeItem(key));
      return current;
    }
    if (current) storage.removeItem(keys.current);
    keys.deprecated.forEach((key) => storage.removeItem(key));
    return "";
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
    keys.deprecated.forEach((key) => storage.removeItem(key));
    return true;
  } catch {
    return false;
  }
}

/** Purge historical keys even when their feature tabs are unopened. */
export function migrateCatalogRootStorage(): void {
  (Object.keys(ROOT_KEYS) as CatalogRootKind[]).forEach(readCatalogRoot);
}
