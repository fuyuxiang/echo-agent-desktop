/** Remove retired catalog-directory preferences without reading or loading their values. */
export function migrateCatalogRootStorage(): void {
  try {
    const keys = ["echoagent.catalog.experts-root.v2", "echoagent.catalog.experts-root.v1", "expertsRoot", "echoagent.catalog.skills-root.v2", "echoagent.catalog.skills-root.v1", "skillsCatalogRoot", "echoagent.catalog.connectors-root.v2", "echoagent.catalog.connectors-root.v1", "connectorsRoot"];
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    // Unavailable browser storage must never prevent startup.
  }
}
