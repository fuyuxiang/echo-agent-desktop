import { beforeEach, describe, expect, it, vi } from "vitest";

const listDir = vi.fn();
vi.mock("@/lib/agent-client", () => ({ listDir: (path: string) => listDir(path) }));

import { applyFileIndexEvent, buildFileIndex } from "../lib/file-index";

interface FakeEntry {
  name: string;
  path: string;
  kind: string;
}

function tree(map: Record<string, FakeEntry[]>) {
  listDir.mockImplementation(async (path: string) => map[path] ?? []);
}

function file(parent: string, name: string): FakeEntry {
  return { name, path: `${parent}/${name}`, kind: "file" };
}

function dir(parent: string, name: string): FakeEntry {
  return { name, path: `${parent}/${name}`, kind: "directory" };
}

describe("buildFileIndex", () => {
  beforeEach(() => listDir.mockReset());

  it("returns workspace-relative sorted paths", async () => {
    tree({
      "/repo": [dir("/repo", "src"), file("/repo", "README.md")],
      "/repo/src": [file("/repo/src", "main.ts"), file("/repo/src", "app.ts")],
    });
    const result = await buildFileIndex("/repo");
    expect(result.paths).toEqual(["README.md", "src/app.ts", "src/main.ts"]);
    expect(result.truncated).toBe(false);
  });

  it("skips noisy build and VCS directories", async () => {
    tree({
      "/repo": [dir("/repo", "node_modules"), dir("/repo", "src"), dir("/repo", ".git")],
      "/repo/src": [file("/repo/src", "a.ts")],
      "/repo/node_modules": [file("/repo/node_modules", "dep.js")],
      "/repo/.git": [file("/repo/.git", "HEAD")],
    });
    const result = await buildFileIndex("/repo");
    expect(result.paths).toEqual(["src/a.ts"]);
  });

  it("reports progress so the palette can render a partial index", async () => {
    tree({
      "/repo": [dir("/repo", "src"), file("/repo", "a.ts")],
      "/repo/src": [file("/repo/src", "b.ts")],
    });
    const onProgress = vi.fn();
    await buildFileIndex("/repo", { onProgress });
    expect(onProgress).toHaveBeenCalled();
    const lastCall = onProgress.mock.calls[onProgress.mock.calls.length - 1];
    expect(lastCall?.[0]).toContain("src/b.ts");
  });

  it("survives an unreadable directory", async () => {
    listDir.mockImplementation(async (path: string) => {
      if (path === "/repo") return [dir("/repo", "locked"), file("/repo", "ok.ts")];
      if (path === "/repo/locked") throw new Error("EACCES");
      return [];
    });
    const result = await buildFileIndex("/repo");
    expect(result.paths).toEqual(["ok.ts"]);
  });

  it("stops when the walk is aborted", async () => {
    const signal = { aborted: false };
    tree({
      "/repo": [dir("/repo", "src")],
      "/repo/src": [file("/repo/src", "a.ts")],
    });
    signal.aborted = true;
    const result = await buildFileIndex("/repo", { signal });
    expect(result.paths).toEqual([]);
  });

  it("returns an empty index without a workspace", async () => {
    const result = await buildFileIndex("");
    expect(result.paths).toEqual([]);
    expect(listDir).not.toHaveBeenCalled();
  });
});

describe("applyFileIndexEvent", () => {
  it("增量添加 Agent 新生成的文件并保持排序去重", () => {
    const next = applyFileIndexEvent(["src/a.ts", "README.md"], "src\\b.ts", false);
    expect(next).toEqual(["README.md", "src/a.ts", "src/b.ts"]);
    expect(applyFileIndexEvent(next, "src/b.ts", false)).toBe(next);
  });

  it("删除文件或目录时同步移除快速打开索引", () => {
    const paths = ["src/a.ts", "src/nested/b.ts", "tests/a.test.ts"];
    expect(applyFileIndexEvent(paths, "src/a.ts", true)).toEqual([
      "src/nested/b.ts",
      "tests/a.test.ts",
    ]);
    expect(applyFileIndexEvent(paths, "src", true)).toEqual(["tests/a.test.ts"]);
  });
});
