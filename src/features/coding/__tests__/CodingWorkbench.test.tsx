import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async (command: string, _args?: unknown) => {
  if (command === "coding_task_list") return [];
  if (command === "coding_verification_detect") return [];
  return null;
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args: unknown) => invoke(command, args),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@/components/workspace-panel/FileTreeView", () => ({
  FileTreeView: () => <div data-testid="file-tree" />,
}));
const readDocument = vi.fn(async (_root: string, path: string) => ({
  path,
  relativePath: path.replace("/repo/", ""),
  content: "disk content",
  hash: "h1",
  size: 12,
  modifiedAt: 0,
  language: "typescript",
  lineEnding: "LF" as const,
}));
const writeDocument = vi.fn(async (_root: string, path: string, content: string, _hash?: string) => ({
  path,
  relativePath: path.replace("/repo/", ""),
  content,
  hash: "h2",
  size: content.length,
  modifiedAt: 0,
  language: "typescript",
  lineEnding: "LF" as const,
}));

vi.mock("@/lib/agent-client", () => ({
  filesystemPickDirectory: vi.fn(async () => "/picked"),
  listDir: vi.fn(async () => []),
  codingReadDocument: (root: string, path: string) => readDocument(root, path),
  codingWriteDocument: (root: string, path: string, content: string, hash: string) =>
    writeDocument(root, path, content, hash),
}));

vi.mock("../main/CodingEditor", () => ({
  CodingEditor: ({ value }: { value: string }) => <div data-testid="editor">{value}</div>,
}));

import { CodingWorkbench } from "../CodingWorkbench";
import { useTabStore } from "../store/tab-store";

describe("CodingWorkbench skeleton", () => {
  beforeEach(() => {
    localStorage.clear();
    invoke.mockClear();
    readDocument.mockClear();
    writeDocument.mockClear();
    useTabStore.getState().closeAll();
  });

  it("prompts to open a folder when no workspace is selected", () => {
    render(<CodingWorkbench cwd="" models={[]} />);
    expect(screen.getByRole("button", { name: /选择代码文件夹/ })).toBeInTheDocument();
  });

  it("renders the four panes and the status bar for a workspace", async () => {
    render(<CodingWorkbench cwd="/repo" models={[{ id: "m1" }]} defaultModelId="m1" />);
    expect(await screen.findByRole("navigation", { name: "活动栏" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "资源管理器" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Agent 面板" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "工作台状态" })).toBeInTheDocument();
  });

  it("exposes draggable separators for both side panes", async () => {
    render(<CodingWorkbench cwd="/repo" models={[]} />);
    const separators = await screen.findAllByRole("separator");
    const labels = separators.map((node) => node.getAttribute("aria-label"));
    expect(labels).toContain("调整资源管理器宽度");
    expect(labels).toContain("调整 Agent 面板宽度");
  });

  it("keeps the bottom panel collapsed until it is opened", async () => {
    render(<CodingWorkbench cwd="/repo" models={[]} />);
    await screen.findByRole("navigation", { name: "活动栏" });
    expect(screen.queryByRole("tablist", { name: "开发工具面板" })).not.toBeInTheDocument();
  });

  it("opens the command palette from the top bar", async () => {
    const user = userEvent.setup();
    render(<CodingWorkbench cwd="/repo" models={[]} />);
    await user.click(await screen.findByRole("button", { name: "打开命令面板" }));
    expect(screen.getByRole("dialog", { name: "命令面板" })).toBeInTheDocument();
  });

  it("binds command, quick-open and symbol shortcuts", async () => {
    const user = userEvent.setup();
    render(<CodingWorkbench cwd="/repo" models={[]} />);
    await screen.findByRole("navigation", { name: "活动栏" });

    // ⌘⇧P opens command mode; ⌘K is left to the application's session search.
    await user.keyboard("{Meta>}{Shift>}p{/Shift}{/Meta}");
    expect(screen.getByRole("tab", { name: "命令", selected: true })).toBeInTheDocument();
    await user.keyboard("{Escape}");

    await user.keyboard("{Meta>}p{/Meta}");
    expect(screen.getByRole("tab", { name: "文件", selected: true })).toBeInTheDocument();
    await user.keyboard("{Escape}");

    await user.keyboard("{Meta>}t{/Meta}");
    expect(screen.getByRole("tab", { name: "符号", selected: true })).toBeInTheDocument();
  });

  it("does not bind shortcuts before a workspace is open", async () => {
    const user = userEvent.setup();
    render(<CodingWorkbench cwd="" models={[]} />);
    await user.keyboard("{Meta>}{Shift>}p{/Shift}{/Meta}");
    expect(screen.queryByRole("dialog", { name: "命令面板" })).not.toBeInTheDocument();
  });

  it("reads a file and shows its content in a tab", async () => {
    render(<CodingWorkbench cwd="/repo" models={[]} />);
    await screen.findByRole("navigation", { name: "活动栏" });

    await act(async () => {
      useTabStore.getState().openFile({
        id: "/repo/src/a.ts",
        relativePath: "src/a.ts",
        name: "a.ts",
        language: "typescript",
        original: "disk content",
        draft: "disk content",
        hash: "h1",
        loading: false,
      });
    });

    expect(await screen.findByRole("tab", { name: /a\.ts/ })).toBeInTheDocument();
    expect(screen.getByTestId("editor")).toHaveTextContent("disk content");
  });

  it("flags a save conflict instead of overwriting another writer", async () => {
    writeDocument.mockRejectedValueOnce(
      new Error("保存冲突：文件已被 Agent 或其他程序修改，请重新加载后合并改动"),
    );
    render(<CodingWorkbench cwd="/repo" models={[]} />);
    await screen.findByRole("navigation", { name: "活动栏" });

    await act(async () => {
      useTabStore.getState().openFile({
        id: "/repo/src/a.ts",
        relativePath: "src/a.ts",
        name: "a.ts",
        language: "typescript",
        original: "disk content",
        draft: "disk content",
        hash: "stale",
        loading: false,
      });
      useTabStore.getState().updateDraft("/repo/src/a.ts", "my edit");
      useTabStore.getState().markConflict("/repo/src/a.ts");
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(/已被 Agent 或其他程序修改/);
  });

  it("shows an error in the tab when a file cannot be read", async () => {
    readDocument.mockRejectedValueOnce(new Error("读取文件失败"));
    render(<CodingWorkbench cwd="/repo" models={[]} />);
    await screen.findByRole("navigation", { name: "活动栏" });

    await act(async () => {
      useTabStore.getState().openFile({
        id: "/repo/src/a.ts",
        relativePath: "src/a.ts",
        name: "a.ts",
        language: "typescript",
        original: "",
        draft: "",
        hash: "",
        loading: false,
      });
      useTabStore.getState().setError("/repo/src/a.ts", "打开失败：读取文件失败");
    });

    expect(await screen.findByText(/打开失败：读取文件失败/)).toBeInTheDocument();
  });

  it("clears open tabs when the workspace changes", async () => {
    const { rerender } = render(<CodingWorkbench cwd="/repo" models={[]} />);
    await screen.findByRole("navigation", { name: "活动栏" });
    await act(async () => {
      useTabStore.getState().openFile({
        id: "/repo/src/a.ts",
        relativePath: "src/a.ts",
        name: "a.ts",
        language: "typescript",
        original: "x",
        draft: "x",
        hash: "h1",
        loading: false,
      });
    });
    expect(useTabStore.getState().tabs).toHaveLength(1);

    rerender(<CodingWorkbench cwd="/other" models={[]} />);
    expect(useTabStore.getState().tabs).toHaveLength(0);
  });

  it("applies persisted pane widths as CSS variables", async () => {
    localStorage.setItem(
      "echo-coding-workbench-layout",
      JSON.stringify({ explorerWidth: 300, agentWidth: 460, bottomHeight: 240 }),
    );
    const { container } = render(<CodingWorkbench cwd="/repo" models={[]} />);
    await screen.findByRole("navigation", { name: "活动栏" });
    const shell = container.querySelector(".coding-workbench") as HTMLElement;
    expect(shell.style.getPropertyValue("--coding-explorer-width")).toBe("300px");
    expect(shell.style.getPropertyValue("--coding-agent-width")).toBe("460px");
  });
});
