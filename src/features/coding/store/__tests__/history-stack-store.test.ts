import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  humanOpLabel,
  MAX_HISTORY,
  useHistoryStackStore,
  type HistoryOp,
} from "@/features/coding/store/history-stack-store";

function freshOp(label: string): HistoryOp {
  return {
    op: "rename",
    cwd: "/repo",
    oldPath: "/repo/original",
    newPath: `/repo/${label}`,
  };
}

describe("useHistoryStackStore", () => {
  beforeEach(() => {
    useHistoryStackStore.setState({ past: [], future: [] });
  });
  afterEach(() => {
    useHistoryStackStore.setState({ past: [], future: [] });
  });

  it("push / undo / redo round-trip", () => {
    useHistoryStackStore.getState().push(freshOp("a.ts"));
    useHistoryStackStore.getState().push(freshOp("b.ts"));
    expect(useHistoryStackStore.getState().past).toHaveLength(2);

    const firstUndo = useHistoryStackStore.getState().peekUndo("/repo");
    if (firstUndo?.op !== "rename") throw new Error("expected rename op");
    expect(firstUndo.newPath).toBe("/repo/b.ts");
    useHistoryStackStore.getState().commitUndo("/repo");
    expect(useHistoryStackStore.getState().past).toHaveLength(1);
    expect(useHistoryStackStore.getState().future).toHaveLength(1);

    const firstRedo = useHistoryStackStore.getState().peekRedo("/repo");
    if (firstRedo?.op !== "rename") throw new Error("expected rename op");
    expect(firstRedo.newPath).toBe("/repo/b.ts");
    useHistoryStackStore.getState().commitRedo("/repo");
    expect(useHistoryStackStore.getState().past).toHaveLength(2);
    expect(useHistoryStackStore.getState().future).toHaveLength(0);
  });

  it("caps the past stack at MAX_HISTORY", () => {
    for (let i = 0; i < MAX_HISTORY + 10; i += 1) {
      useHistoryStackStore.getState().push(freshOp(`f${i}.ts`));
    }
    const past = useHistoryStackStore.getState().past;
    expect(past).toHaveLength(MAX_HISTORY);
    const first = past[0];
    const last = past[past.length - 1];
    if (first.op !== "rename" || last.op !== "rename") {
      throw new Error("expected rename ops");
    }
    expect(first.newPath).toBe(`/repo/f10.ts`);
    expect(last.newPath).toBe(`/repo/f${MAX_HISTORY + 9}.ts`);
  });

  it("a fresh push clears the redo stack", () => {
    useHistoryStackStore.getState().push(freshOp("a.ts"));
    useHistoryStackStore.getState().push(freshOp("b.ts"));
    useHistoryStackStore.getState().commitUndo("/repo");
    expect(useHistoryStackStore.getState().future).toHaveLength(1);
    useHistoryStackStore.getState().push(freshOp("c.ts"));
    expect(useHistoryStackStore.getState().future).toHaveLength(0);
  });

  it("undo returns null on an empty stack", () => {
    expect(useHistoryStackStore.getState().peekUndo("/repo")).toBeNull();
    expect(useHistoryStackStore.getState().peekRedo("/repo")).toBeNull();
  });

  it("clear drops both stacks", () => {
    useHistoryStackStore.getState().push(freshOp("a.ts"));
    useHistoryStackStore.getState().push(freshOp("b.ts"));
    useHistoryStackStore.getState().commitUndo("/repo");
    useHistoryStackStore.getState().clear();
    expect(useHistoryStackStore.getState().past).toHaveLength(0);
    expect(useHistoryStackStore.getState().future).toHaveLength(0);
  });

  it("keeps undo and redo histories independent per workspace", () => {
    useHistoryStackStore.getState().push(freshOp("a.ts"));
    useHistoryStackStore.getState().push({
      op: "create",
      cwd: "/other",
      path: "/other/new.ts",
      isDir: false,
    });

    const repoEntry = useHistoryStackStore.getState().peekUndo("/repo");
    expect(repoEntry?.op).toBe("rename");
    useHistoryStackStore.getState().commitUndo("/repo");

    expect(useHistoryStackStore.getState().peekUndo("/repo")).toBeNull();
    expect(useHistoryStackStore.getState().peekUndo("/other")?.op).toBe("create");
    expect(useHistoryStackStore.getState().peekRedo("/repo")?.op).toBe("rename");
  });

  it("humanOpLabel maps every op to a Chinese label", () => {
    expect(humanOpLabel("rename")).toBe("重命名");
    expect(humanOpLabel("delete")).toBe("删除");
    expect(humanOpLabel("copy")).toBe("复制");
    expect(humanOpLabel("move")).toBe("移动");
    expect(humanOpLabel("create")).toBe("新建");
    expect(humanOpLabel("paste")).toBe("粘贴");
  });
});
