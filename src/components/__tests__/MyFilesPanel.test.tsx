import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("@/lib/agent-client", () => ({
  listDir: vi.fn(),
  openLocalPath: vi.fn().mockResolvedValue(undefined),
}));

import { listDir, openLocalPath, type DirEntry } from "@/lib/agent-client";
import { MyFilesPanel } from "../MyFilesPanel";

const file = (name: string, root: string): DirEntry => ({
  name,
  path: `${root}/${name}`,
  kind: "file",
  size: 12,
  modifiedAt: Date.now(),
});

beforeEach(() => {
  vi.mocked(listDir).mockReset().mockResolvedValue([]);
  vi.mocked(openLocalPath).mockClear();
});

describe("MyFilesPanel", () => {
  it("工作空间切换时忽略晚到的旧目录响应", async () => {
    let resolveOld!: (entries: DirEntry[]) => void;
    const oldRequest = new Promise<DirEntry[]>((resolve) => { resolveOld = resolve; });
    vi.mocked(listDir)
      .mockImplementationOnce(() => oldRequest)
      .mockResolvedValueOnce([file("new.txt", "/work/two")]);

    const { rerender } = render(<MyFilesPanel cwd="/work/one" />);
    fireEvent.click(screen.getByRole("button", { name: /本地文件/ }));
    await waitFor(() => expect(listDir).toHaveBeenCalledWith("/work/one", "/work/one", 2000));

    rerender(<MyFilesPanel cwd="/work/two" />);
    expect(await screen.findByText("new.txt")).toBeInTheDocument();
    expect(listDir).toHaveBeenCalledWith("/work/two", "/work/two", 2000);

    await act(async () => {
      resolveOld([file("old.txt", "/work/one")]);
      await oldRequest;
    });
    expect(screen.queryByText("old.txt")).not.toBeInTheDocument();

    const row = screen.getByRole("button", { name: "打开文件 new.txt" });
    fireEvent.keyDown(row, { key: "Enter" });
    expect(openLocalPath).toHaveBeenCalledWith("/work/two/new.txt", "/work/two");
  });

  it("目录加载失败显示错误与重试，不误报暂无文件", async () => {
    vi.mocked(listDir)
      .mockRejectedValueOnce(new Error("权限不足"))
      .mockResolvedValueOnce([]);
    render(<MyFilesPanel cwd="/work/one" />);
    fireEvent.click(screen.getByRole("button", { name: /本地文件/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("读取目录失败：权限不足");
    expect(screen.queryByText("暂无文件")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /重试/ }));
    expect(await screen.findByText("暂无文件")).toBeInTheDocument();
  });
});
