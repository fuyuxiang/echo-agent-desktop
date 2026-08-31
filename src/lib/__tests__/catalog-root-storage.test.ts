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

  it("drops ambiguous v1 roots so the backend can follow ECHO_AGENT_HOME", () => {
    localStorage.setItem("expertsRoot", "/Users/demo/EchoAgent/agents");
    localStorage.setItem(
      "echoagent.catalog.experts-root.v1",
      "/Users/demo/.echo-agent/experts-marketplace",
    );

    expect(readCatalogRoot("experts")).toBe("");
    expect(localStorage.getItem("expertsRoot")).toBeNull();
    expect(localStorage.getItem("echoagent.catalog.experts-root.v1"))
      .toBeNull();
  });

  it("prefers the explicit v2 override and removes old keys", () => {
    localStorage.setItem(
      "echoagent.catalog.skills-root.v2",
      "/Users/demo/custom-skills-marketplace",
    );
    localStorage.setItem("echoagent.catalog.skills-root.v1", "/Users/demo/.echo-agent/skills");
    localStorage.setItem("skillsCatalogRoot", "/tmp/old-skills");

    expect(readCatalogRoot("skills")).toBe("/Users/demo/custom-skills-marketplace");
    expect(localStorage.getItem("echoagent.catalog.skills-root.v1")).toBeNull();
    expect(localStorage.getItem("skillsCatalogRoot")).toBeNull();
  });

  it("recognizes both Unix and Windows legacy directory components", () => {
    expect(isLegacyWorkBuddyPath("/Users/demo/.workbuddy/catalog")).toBe(true);
    expect(isLegacyWorkBuddyPath("C:\\Users\\demo\\WorkBuddy\\catalog")).toBe(true);
    expect(isLegacyWorkBuddyPath("/Users/demo/workbuddy-notes/catalog")).toBe(false);
  });

  it("never stores a blocked root", () => {
    expect(writeCatalogRoot("connectors", "/Users/demo/.workbuddy/connectors")).toBe(false);
    expect(localStorage.getItem("echoagent.catalog.connectors-root.v2")).toBeNull();

    expect(writeCatalogRoot("connectors", "/Users/demo/.echo-agent/connectors-marketplace"))
      .toBe(true);
    expect(readCatalogRoot("connectors"))
      .toBe("/Users/demo/.echo-agent/connectors-marketplace");
    expect(localStorage.getItem("echoagent.catalog.connectors-root.v2"))
      .toBe("/Users/demo/.echo-agent/connectors-marketplace");
  });
});
