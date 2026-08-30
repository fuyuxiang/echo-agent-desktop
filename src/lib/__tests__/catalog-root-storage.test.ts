import { beforeEach, describe, expect, it } from "vitest";
import {
  isLegacyWorkBuddyPath,
  migrateCatalogRootStorage,
  readCatalogRoot,
  writeCatalogRoot,
} from "../catalog-root-storage";

describe("catalog root storage migration", () => {
  beforeEach(() => localStorage.clear());

  it("clears historical WorkBuddy roots instead of loading them", () => {
    localStorage.setItem("skillsCatalogRoot", "/Users/demo/.workbuddy/connectors-marketplace");
    localStorage.setItem("connectorsRoot", "C:\\Users\\demo\\.WorkBuddy\\marketplace");

    migrateCatalogRootStorage();

    expect(readCatalogRoot("skills")).toBe("");
    expect(readCatalogRoot("connectors")).toBe("");
    expect(localStorage.getItem("skillsCatalogRoot")).toBeNull();
    expect(localStorage.getItem("connectorsRoot")).toBeNull();
  });

  it("migrates a valid legacy root to the namespaced key", () => {
    localStorage.setItem("expertsRoot", "/Users/demo/EchoAgent/agents");

    expect(readCatalogRoot("experts")).toBe("/Users/demo/EchoAgent/agents");
    expect(localStorage.getItem("expertsRoot")).toBeNull();
    expect(localStorage.getItem("echoagent.catalog.experts-root.v1"))
      .toBe("/Users/demo/EchoAgent/agents");
  });

  it("prefers the current namespaced root and removes the old key", () => {
    localStorage.setItem("echoagent.catalog.skills-root.v1", "/Users/demo/.echo-agent/skills");
    localStorage.setItem("skillsCatalogRoot", "/tmp/old-skills");

    expect(readCatalogRoot("skills")).toBe("/Users/demo/.echo-agent/skills");
    expect(localStorage.getItem("skillsCatalogRoot")).toBeNull();
  });

  it("recognizes both Unix and Windows legacy directory components", () => {
    expect(isLegacyWorkBuddyPath("/Users/demo/.workbuddy/catalog")).toBe(true);
    expect(isLegacyWorkBuddyPath("C:\\Users\\demo\\WorkBuddy\\catalog")).toBe(true);
    expect(isLegacyWorkBuddyPath("/Users/demo/workbuddy-notes/catalog")).toBe(false);
  });

  it("never stores a blocked root", () => {
    expect(writeCatalogRoot("connectors", "/Users/demo/.workbuddy/connectors")).toBe(false);
    expect(localStorage.getItem("echoagent.catalog.connectors-root.v1")).toBeNull();

    expect(writeCatalogRoot("connectors", "/Users/demo/.echo-agent/connectors-marketplace"))
      .toBe(true);
    expect(readCatalogRoot("connectors"))
      .toBe("/Users/demo/.echo-agent/connectors-marketplace");
  });
});
