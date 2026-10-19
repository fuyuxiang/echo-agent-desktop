import { invoke } from "@tauri-apps/api/core";
import { registerDocumentArtifact } from "@/lib/artifact-catalog";
vi.mock("@tauri-apps/api/core", () => ({invoke: vi.fn()}));
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("@/lib/agent-client", () => ({
  listDir: vi.fn(),
  openLocalPath: vi.fn().mockResolvedValue(undefined),
  filesystemPickFiles: vi.fn().mockResolvedValue([]),
}));

import { listDir, openLocalPath, type DirEntry } from "@/lib/agent-client";
import { MyFilesPanel } from "../MyFilesPanel";

const file = (name: string, root: string): DirEntry => ({
  name,
  path: `${root}/${name}`,
  kind: "file",
  size: 12,
  modifiedAt: Date.now(),
  isLarge: false,
  isBinary: false,
});

beforeEach(() => {
  localStorage.clear(); vi.mocked(invoke).mockReset().mockResolvedValue(undefined);
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

  it("历史任务成果在核验原生回执后才交给系统打开", async () => {
    const receipt = {path: "/outside/report.docx", format: "docx" as const, byteSize: 10, sha256: "b".repeat(64)};
    registerDocumentArtifact(receipt, "historical-session", "历史报告", "/old-workspace");
    let ready!: () => void;
    vi.mocked(invoke).mockImplementation(async command => {
      if (command === "session_export_authorize") return new Promise<void>(resolve => {ready = resolve;});
      return undefined;
    });
    render(<MyFilesPanel cwd="/new-workspace" />);
    fireEvent.click(await screen.findByRole("button", {name: "打开成果 /outside/report.docx"}));
    expect(invoke).toHaveBeenCalledWith("session_export_authorize", {sessionId: "historical-session", path: receipt.path, sha256: receipt.sha256});
    expect(openLocalPath).not.toHaveBeenCalled();
    await act(async () => {ready();});
    expect(openLocalPath).toHaveBeenCalledWith(receipt.path, "/old-workspace");
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

it("reads native receipts after cache loss without loading the original transcript, and retries failures", async () => {
  const receipt = { path: "/outside/native.docx", format: "docx", byteSize: 10, sha256: "c".repeat(64) };
  vi.mocked(invoke).mockRejectedValueOnce(new Error("ledger unavailable")).mockResolvedValueOnce([
    { sessionId: "archived", sessionTitle: "已归档任务", cwd: "/old", receipt, title: "原生文档", createdAt: 1 },
  ]).mockResolvedValue(undefined);
  render(<MyFilesPanel cwd="/new" />);
  expect(await screen.findByRole("alert")).toHaveTextContent("ledger unavailable");
  fireEvent.click(screen.getByRole("button", {name: "重试"}));
  const row = await screen.findByRole("button", {name: "打开成果 /outside/native.docx"});
  fireEvent.click(row);
  await waitFor(() => expect(openLocalPath).toHaveBeenCalledWith(receipt.path, "/old"));
  expect(invoke).toHaveBeenCalledWith("session_export_authorize", {sessionId: "archived", path: receipt.path, sha256: receipt.sha256});
});
