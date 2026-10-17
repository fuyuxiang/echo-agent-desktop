import { beforeEach, describe, expect, it } from "vitest";
import { migrateCatalogRootStorage } from "../catalog-root-storage";

describe("retired catalog preferences", () => {
  beforeEach(() => localStorage.clear());
  it("purges every retired source key while preserving unrelated preferences", () => {
    const keys = ["expertsRoot", "skillsCatalogRoot", "connectorsRoot",
      ...["experts", "skills", "connectors"].flatMap(kind => [1, 2].map(version => `echoagent.catalog.${kind}-root.v${version}`))];
    keys.forEach(key => localStorage.setItem(key, "/retired/catalog"));
    localStorage.setItem("echoagent.theme", "dark");
    migrateCatalogRootStorage();
    keys.forEach(key => expect(localStorage.getItem(key)).toBeNull());
    expect(localStorage.getItem("echoagent.theme")).toBe("dark");
    migrateCatalogRootStorage();
    expect(localStorage.getItem("echoagent.theme")).toBe("dark");
  });
});
