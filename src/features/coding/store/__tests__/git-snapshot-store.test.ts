import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const codingGitSnapshotMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/agent-client", () => ({
  codingGitSnapshot: codingGitSnapshotMock,
}));

import type { CodingGitFile, CodingGitSnapshot } from "@/lib/agent-client";
import {
  useGitSnapshotStore,
  lookupGitStatus,
} from "@/features/coding/store/git-snapshot-store";

const sampleSnapshot: CodingGitSnapshot = {
  hasGit: true,
  branch: "main",
  head: "abc1234",
  files: [
    { path: "src/a.ts", status: "modified", staged: false, unstaged: true, untracked: false, added: 1, removed: 2 },
    { path: "new.ts", status: "added", staged: true, unstaged: false, untracked: false, added: 10, removed: 0 },
    { path: "nested/b.ts", status: "untracked", staged: false, unstaged: false, untracked: true, added: 0, removed: 0 },
  ] satisfies CodingGitFile[],
  totalAdded: 11,
  totalRemoved: 2,
  capturedAt: "2026-01-01T00:00:00Z",
};

describe("useGitSnapshotStore", () => {
  beforeEach(() => {
    useGitSnapshotStore.getState().clear();
    codingGitSnapshotMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refresh 调用 codingGitSnapshot, byPath 按 POSIX 归一", async () => {
    codingGitSnapshotMock.mockResolvedValue(sampleSnapshot);
    await useGitSnapshotStore.getState().refresh("/x/repo");
    expect(codingGitSnapshotMock).toHaveBeenCalledWith("/x/repo");
    expect(useGitSnapshotStore.getState().snapshot).toEqual(
      expect.objectContaining({ hasGit: true }),
    );
    expect(useGitSnapshotStore.getState().byPath.get("src/a.ts")?.status).toBe("modified");
    expect(useGitSnapshotStore.getState().byPath.get("nested/b.ts")?.status).toBe("untracked");
  });

  it("refresh 失败保留原 snapshot 并填充 error", async () => {
    useGitSnapshotStore.setState({
      root: "/x",
      snapshot: sampleSnapshot,
      byPath: new Map(),
      loading: false,
      error: null,
      lastFetched: 0,
    });
    codingGitSnapshotMock.mockRejectedValue(new Error("boom"));
    await useGitSnapshotStore.getState().refresh("/x");
    expect(useGitSnapshotStore.getState().error).toContain("boom");
    // Snapshot should be preserved.
    expect(useGitSnapshotStore.getState().snapshot).toEqual(sampleSnapshot);
  });

  it("empty root clears store", async () => {
    useGitSnapshotStore.setState({
      snapshot: sampleSnapshot,
      byPath: new Map([["src/a.ts", sampleSnapshot.files[0]]]),
      loading: false,
      error: null,
      lastFetched: 0,
    });
    await useGitSnapshotStore.getState().refresh("");
    expect(useGitSnapshotStore.getState().snapshot).toBeNull();
    expect(useGitSnapshotStore.getState().byPath.size).toBe(0);
  });

  it("500ms 内不重抓", async () => {
    codingGitSnapshotMock.mockResolvedValue(sampleSnapshot);
    await useGitSnapshotStore.getState().refresh("/x");
    await useGitSnapshotStore.getState().refresh("/x");
    expect(codingGitSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it("workspace 切换后忽略旧 workspace 的迟到响应", async () => {
    let resolveA: ((snapshot: CodingGitSnapshot) => void) | undefined;
    const pendingA = new Promise<CodingGitSnapshot>((resolve) => { resolveA = resolve; });
    const snapshotB = { ...sampleSnapshot, branch: "feature-b" };
    codingGitSnapshotMock
      .mockReturnValueOnce(pendingA)
      .mockResolvedValueOnce(snapshotB);

    const refreshA = useGitSnapshotStore.getState().refresh("/a");
    await useGitSnapshotStore.getState().refresh("/b");
    resolveA?.({ ...sampleSnapshot, branch: "stale-a" });
    await refreshA;

    expect(useGitSnapshotStore.getState().root).toBe("/b");
    expect(useGitSnapshotStore.getState().snapshot?.branch).toBe("feature-b");
  });
});

describe("lookupGitStatus", () => {
  const map = new Map([
    ["src/a.ts", sampleSnapshot.files[0]],
  ]);
  const relOf = (abs: string) => {
    if (abs === "/repo") return "";
    if (abs.startsWith("/repo/")) return abs.slice("/repo/".length);
    return null;
  };

  it("命中", () => {
    expect(lookupGitStatus(map, "/repo/src/a.ts", relOf)?.status).toBe("modified");
  });

  it("未命中返回 undefined", () => {
    expect(lookupGitStatus(map, "/repo/missing.ts", relOf)).toBeUndefined();
  });

  it("非工作区路径返回 undefined", () => {
    expect(lookupGitStatus(map, "/other/src/a.ts", relOf)).toBeUndefined();
  });
});
