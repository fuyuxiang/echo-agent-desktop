import { beforeEach, describe, expect, it } from "vitest";

import { isDirty, useTabStore, type FileTab } from "../store/tab-store";

function fileTab(overrides: Partial<FileTab> = {}) {
  return {
    id: "/repo/src/a.ts",
    relativePath: "src/a.ts",
    name: "a.ts",
    language: "typescript",
    original: "original",
    draft: "original",
    hash: "h1",
    loading: false,
    ...overrides,
  };
}

describe("tab store", () => {
  beforeEach(() => useTabStore.getState().closeAll());

  it("opens a file and focuses it", () => {
    useTabStore.getState().openFile(fileTab());
    expect(useTabStore.getState().tabs).toHaveLength(1);
    expect(useTabStore.getState().activeId).toBe("/repo/src/a.ts");
  });

  it("re-opening a file focuses it without discarding unsaved edits", () => {
    useTabStore.getState().openFile(fileTab());
    useTabStore.getState().updateDraft("/repo/src/a.ts", "edited");
    useTabStore.getState().openFile(fileTab({ original: "reloaded", draft: "reloaded" }));
    const tab = useTabStore.getState().tabs[0] as FileTab;
    expect(useTabStore.getState().tabs).toHaveLength(1);
    expect(tab.draft).toBe("edited");
  });

  it("tracks dirty state from the draft/disk difference", () => {
    useTabStore.getState().openFile(fileTab());
    expect(isDirty(useTabStore.getState().tabs[0])).toBe(false);
    useTabStore.getState().updateDraft("/repo/src/a.ts", "changed");
    expect(isDirty(useTabStore.getState().tabs[0])).toBe(true);
  });

  it("saving clears dirty state and stores the new hash", () => {
    useTabStore.getState().openFile(fileTab());
    useTabStore.getState().updateDraft("/repo/src/a.ts", "changed");
    useTabStore.getState().markSaved("/repo/src/a.ts", "changed", "h2");
    const tab = useTabStore.getState().tabs[0] as FileTab;
    expect(isDirty(tab)).toBe(false);
    expect(tab.hash).toBe("h2");
  });

  it("saving clears a previous conflict flag", () => {
    useTabStore.getState().openFile(fileTab());
    useTabStore.getState().markConflict("/repo/src/a.ts");
    expect((useTabStore.getState().tabs[0] as FileTab).conflict).toBe(true);
    useTabStore.getState().markSaved("/repo/src/a.ts", "merged", "h3");
    expect((useTabStore.getState().tabs[0] as FileTab).conflict).toBe(false);
  });

  it("restoring a deleted file clears its conflict and stale error", () => {
    useTabStore.getState().openFile(fileTab());
    useTabStore.getState().markConflict("/repo/src/a.ts");
    useTabStore.getState().setError("/repo/src/a.ts", "文件已移到回收站");
    useTabStore.getState().clearConflict("/repo/src/a.ts");
    expect(useTabStore.getState().tabs[0]).toMatchObject({
      conflict: false,
      error: undefined,
    });
  });

  it("renaming a directory remaps descendant tabs and the active id", () => {
    useTabStore.getState().openFile(fileTab());
    useTabStore.getState().openFile(fileTab({
      id: "/repo/src/nested/b.ts",
      relativePath: "src/nested/b.ts",
      name: "b.ts",
    }));
    useTabStore.getState().renameTab("/repo/src", "/repo/source");
    expect(useTabStore.getState().tabs.map((tab) => tab.id)).toEqual([
      "/repo/source/a.ts",
      "/repo/source/nested/b.ts",
    ]);
    expect(useTabStore.getState().tabs.map((tab) => (tab as FileTab).relativePath)).toEqual([
      "source/a.ts",
      "source/nested/b.ts",
    ]);
    expect(useTabStore.getState().activeId).toBe("/repo/source/nested/b.ts");
  });

  it("closing the active tab focuses the tab that takes its place", () => {
    useTabStore.getState().openFile(fileTab({ id: "a", name: "a" }));
    useTabStore.getState().openFile(fileTab({ id: "b", name: "b" }));
    useTabStore.getState().openFile(fileTab({ id: "c", name: "c" }));
    useTabStore.getState().setActive("b");
    useTabStore.getState().closeTab("b");
    expect(useTabStore.getState().activeId).toBe("c");
  });

  it("closing the last tab focuses its left neighbour", () => {
    useTabStore.getState().openFile(fileTab({ id: "a" }));
    useTabStore.getState().openFile(fileTab({ id: "b" }));
    useTabStore.getState().closeTab("b");
    expect(useTabStore.getState().activeId).toBe("a");
  });

  it("closing an inactive tab keeps the current focus", () => {
    useTabStore.getState().openFile(fileTab({ id: "a" }));
    useTabStore.getState().openFile(fileTab({ id: "b" }));
    useTabStore.getState().setActive("a");
    useTabStore.getState().closeTab("b");
    expect(useTabStore.getState().activeId).toBe("a");
  });

  it("closing the only tab leaves nothing focused", () => {
    useTabStore.getState().openFile(fileTab());
    useTabStore.getState().closeTab("/repo/src/a.ts");
    expect(useTabStore.getState().tabs).toHaveLength(0);
    expect(useTabStore.getState().activeId).toBeNull();
  });

  it("opens virtual document tabs at most once each", () => {
    useTabStore.getState().openDoc("delivery");
    useTabStore.getState().openDoc("delivery");
    useTabStore.getState().openDoc("taskDag");
    expect(useTabStore.getState().tabs).toHaveLength(2);
    expect(useTabStore.getState().activeId).toBe("doc:taskDag");
  });

  it("document tabs are never dirty", () => {
    useTabStore.getState().openDoc("profile");
    expect(isDirty(useTabStore.getState().tabs[0])).toBe(false);
  });

  it("switches a file between edit and diff views", () => {
    useTabStore.getState().openFile(fileTab());
    useTabStore.getState().setView("/repo/src/a.ts", "diff");
    expect((useTabStore.getState().tabs[0] as FileTab).view).toBe("diff");
  });

  it("shows an exact diff even when reading the current file failed", () => {
    useTabStore.getState().openFile(fileTab({ loading: true }));
    useTabStore.getState().setError("/repo/src/a.ts", "file was deleted");
    useTabStore.getState().setDiff("/repo/src/a.ts", "before", "");
    const tab = useTabStore.getState().tabs[0] as FileTab;
    expect(tab.view).toBe("diff");
    expect(tab.loading).toBe(false);
    expect(tab.error).toBeUndefined();
    expect(tab.diffOriginal).toBe("before");
    expect(tab.diffModified).toBe("");
  });

  it("keeps a task diff visible while the clean disk snapshot is reconciled", () => {
    useTabStore.getState().openFile(fileTab());
    useTabStore.getState().setDiff("/repo/src/a.ts", "baseline", "agent edit", false, "t1");
    useTabStore.getState().markSaved("/repo/src/a.ts", "agent edit", "h2");
    const tab = useTabStore.getState().tabs[0] as FileTab;
    expect(tab).toMatchObject({
      view: "diff",
      diffOriginal: "baseline",
      diffModified: "agent edit",
      diffTaskId: "t1",
      hash: "h2",
    });
  });

  it("clears a cached task diff when its task is no longer current", () => {
    useTabStore.getState().openFile(fileTab());
    useTabStore.getState().setDiff("/repo/src/a.ts", "baseline", "agent edit", false, "t1");
    useTabStore.getState().clearDiff("/repo/src/a.ts");
    const tab = useTabStore.getState().tabs[0] as FileTab;
    expect(tab.view).toBe("edit");
    expect(tab.diffOriginal).toBeUndefined();
    expect(tab.diffModified).toBeUndefined();
    expect(tab.diffTaskId).toBeUndefined();
  });

  it("opening the same symbol twice focuses the existing virtual tab", () => {
    useTabStore.getState().openVirtual("findReferences", "/repo", { name: "authenticate" });
    useTabStore.getState().openFile(fileTab({ id: "/repo/src/a.ts" }));
    useTabStore.getState().openVirtual("findReferences", "/repo", { name: "authenticate" });
    expect(useTabStore.getState().tabs).toHaveLength(2);
    expect(useTabStore.getState().activeId).toBe("virtual:findReferences:authenticate");
  });

  it("different virtual kinds for the same symbol create separate tabs", () => {
    useTabStore.getState().openVirtual("findReferences", "/repo", { name: "authenticate" });
    useTabStore.getState().openVirtual("impactAnalysis", "/repo", { name: "authenticate" });
    expect(useTabStore.getState().tabs).toHaveLength(2);
    expect(useTabStore.getState().activeId).toBe("virtual:impactAnalysis:authenticate");
  });
});
