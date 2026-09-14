import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listDir = vi.fn();
vi.mock("@/lib/agent-client", () => ({
  listDir: (path: string) => listDir(path),
}));

import { FileTreeView } from "@/components/workspace-panel/FileTreeView";

interface Entry {
  name: string;
  path: string;
  kind: "file" | "directory";
  size: number;
  modifiedAt: number;
}

function file(parent: string, name: string): Entry {
  return { name, path: `${parent}/${name}`, kind: "file", size: 1, modifiedAt: 1 };
}

function dir(parent: string, name: string): Entry {
  return { name, path: `${parent}/${name}`, kind: "directory", size: 0, modifiedAt: 1 };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function tree(overrides: Partial<Parameters<typeof FileTreeView>[0]> = {}) {
  return (
    <FileTreeView
      rootPath="/repo"
      onFileSelect={vi.fn()}
      {...overrides}
    />
  );
}

describe("FileTreeView live refresh", () => {
  beforeEach(() => listDir.mockReset());

  it("后台刷新时保留当前文件，不闪回空树", async () => {
    const refresh = deferred<Entry[]>();
    listDir
      .mockResolvedValueOnce([file("/repo", "a.ts")])
      .mockReturnValueOnce(refresh.promise);
    const view = render(tree({ refreshKey: 0 }));
    expect(await screen.findByRole("treeitem", { name: /a\.ts/ })).toBeInTheDocument();

    view.rerender(tree({ refreshKey: 1, refreshPaths: ["b.ts"] }));
    expect(screen.getByRole("treeitem", { name: /a\.ts/ })).toBeInTheDocument();
    expect(screen.queryByText("加载文件树中…")).not.toBeInTheDocument();
    await waitFor(() => expect(listDir).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("treeitem", { name: /a\.ts/ })).toBeInTheDocument();

    await act(async () => refresh.resolve([file("/repo", "a.ts"), file("/repo", "b.ts")]));
    expect(await screen.findByRole("treeitem", { name: /b\.ts/ })).toBeInTheDocument();
  });

  it("只刷新变更所在的已加载目录，并保留展开状态", async () => {
    const refresh = deferred<Entry[]>();
    listDir.mockImplementation((path: string) => {
      if (path === "/repo") return Promise.resolve([dir("/repo", "src")]);
      if (listDir.mock.calls.filter(([called]) => called === "/repo/src").length === 1) {
        return Promise.resolve([file("/repo/src", "a.ts")]);
      }
      return refresh.promise;
    });
    const user = userEvent.setup();
    const view = render(tree({ refreshKey: 0 }));
    const source = await screen.findByRole("treeitem", { name: /src/ });
    await user.click(source);
    expect(await screen.findByRole("treeitem", { name: /a\.ts/ })).toBeInTheDocument();

    view.rerender(tree({ refreshKey: 1, refreshPaths: ["src/b.ts"] }));
    await waitFor(() => expect(listDir).toHaveBeenCalledTimes(3));
    expect(source).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("treeitem", { name: /a\.ts/ })).toBeInTheDocument();
    expect(listDir.mock.calls.filter(([path]) => path === "/repo")).toHaveLength(1);

    await act(async () => refresh.resolve([
      file("/repo/src", "a.ts"),
      file("/repo/src", "b.ts"),
    ]));
    expect(await screen.findByRole("treeitem", { name: /b\.ts/ })).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: /src/ })).toHaveAttribute("aria-expanded", "true");
  });

  it("并发刷新只接受最新响应，迟到数据不会回滚文件树", async () => {
    const older = deferred<Entry[]>();
    const latest = deferred<Entry[]>();
    listDir
      .mockResolvedValueOnce([file("/repo", "base.ts")])
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(latest.promise);
    const view = render(tree({ refreshKey: 0 }));
    expect(await screen.findByRole("treeitem", { name: /base\.ts/ })).toBeInTheDocument();

    view.rerender(tree({ refreshKey: 1, refreshPaths: ["older.ts"] }));
    await waitFor(() => expect(listDir).toHaveBeenCalledTimes(2));
    view.rerender(tree({ refreshKey: 2, refreshPaths: ["latest.ts"] }));
    await waitFor(() => expect(listDir).toHaveBeenCalledTimes(3));
    await act(async () => latest.resolve([file("/repo", "latest.ts")]));
    expect(await screen.findByRole("treeitem", { name: /latest\.ts/ })).toBeInTheDocument();

    await act(async () => older.resolve([file("/repo", "older.ts")]));
    expect(screen.getByRole("treeitem", { name: /latest\.ts/ })).toBeInTheDocument();
    expect(screen.queryByRole("treeitem", { name: /older\.ts/ })).not.toBeInTheDocument();
  });

  it("工作区切换后忽略旧根目录的迟到响应", async () => {
    const oldRoot = deferred<Entry[]>();
    listDir.mockImplementation((path: string) => path === "/old"
      ? oldRoot.promise
      : Promise.resolve([file("/new", "new.ts")]));
    const view = render(tree({ rootPath: "/old" }));
    await waitFor(() => expect(listDir).toHaveBeenCalledWith("/old"));
    view.rerender(tree({ rootPath: "/new" }));
    expect(await screen.findByRole("treeitem", { name: /new\.ts/ })).toBeInTheDocument();

    await act(async () => oldRoot.resolve([file("/old", "old.ts")]));
    expect(screen.queryByRole("treeitem", { name: /old\.ts/ })).not.toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: /new\.ts/ })).toBeInTheDocument();
  });

  it("刷新失败时保留上次成功数据，首次加载失败可重试", async () => {
    const onToast = vi.fn();
    listDir
      .mockResolvedValueOnce([file("/repo", "safe.ts")])
      .mockRejectedValueOnce(new Error("temporary failure"));
    const view = render(tree({ refreshKey: 0, onToast }));
    expect(await screen.findByRole("treeitem", { name: /safe\.ts/ })).toBeInTheDocument();
    view.rerender(tree({ refreshKey: 1, refreshPaths: ["safe.ts"], onToast }));
    await waitFor(() => expect(onToast).toHaveBeenCalledWith("读取目录失败：temporary failure"));
    expect(screen.getByRole("treeitem", { name: /safe\.ts/ })).toBeInTheDocument();

    listDir
      .mockReset()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce([file("/other", "recovered.ts")]);
    view.rerender(tree({ rootPath: "/other", onToast }));
    const retry = await screen.findByRole("button", { name: "重试" });
    await userEvent.click(retry);
    expect(await screen.findByRole("treeitem", { name: /recovered\.ts/ })).toBeInTheDocument();
  });
});
