import { beforeEach, describe, expect, it } from "vitest";

import { codingTaskDraftKey, loadCodingHotExit, saveCodingHotExit } from "../lib/hot-exit";
import type { FileTab } from "../store/tab-store";

function file(overrides: Partial<FileTab> = {}): FileTab {
  return {
    type: "file",
    id: "/repo/src/a.ts",
    relativePath: "src/a.ts",
    name: "a.ts",
    language: "typescript",
    original: "disk",
    draft: "draft",
    hash: "h1",
    view: "edit",
    loading: false,
    ...overrides,
  };
}

describe("coding hot exit", () => {
  beforeEach(() => localStorage.clear());

  it("restores tabs, selection and explorer state for the same project", () => {
    saveCodingHotExit({
      version: 1,
      root: "/repo",
      tabs: [file(), { type: "doc", id: "doc:delivery", kind: "delivery", title: "交付报告" }],
      activeId: "doc:delivery",
      selectedDirectory: "/repo/src",
      expandedPaths: ["/repo/src"],
      minimapEnabled: false,
      savedAt: 42,
    });

    expect(loadCodingHotExit("/repo")).toMatchObject({
      activeId: "doc:delivery",
      selectedDirectory: "/repo/src",
      expandedPaths: ["/repo/src"],
      minimapEnabled: false,
      savedAt: 42,
    });
    expect(loadCodingHotExit("/another-repo")).toBeNull();
  });

  it("rejects corrupt state instead of breaking workbench startup", () => {
    localStorage.setItem("echo-coding-hot-exit-v1:%2Frepo", "{not-json");
    expect(loadCodingHotExit("/repo")).toBeNull();
  });

  it("uses a project-scoped task draft key", () => {
    expect(codingTaskDraftKey("/repo-a")).not.toBe(codingTaskDraftKey("/repo-b"));
  });
});
