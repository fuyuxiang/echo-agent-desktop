import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async (command: string, _args?: unknown): Promise<unknown> => {
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

// These shared components reach for session/permission plumbing that is out of
// scope here; the workbench only needs to render them.
vi.mock("@/components/PermissionPicker", () => ({
  PermissionPicker: () => <div data-testid="permission-picker" />,
}));
vi.mock("@/components/ModelSelector", () => ({
  ModelSelector: () => <div data-testid="model-selector" />,
}));
vi.mock("@/components/PermissionDialog", () => ({
  PermissionInlineCard: () => <div data-testid="permission-card" />,
}));
vi.mock("@/components/QuestionInlineCard", () => ({
  QuestionInlineCard: () => <div data-testid="question-card" />,
}));
vi.mock("@/components/ExecutionProcess", () => ({
  ExecutionProcess: () => <div data-testid="execution" />,
}));
vi.mock("@/components/Markdown", () => ({
  Markdown: ({ children }: { children: string }) => <div>{children}</div>,
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

  it("switches the explorer pane from the activity bar", async () => {
    const user = userEvent.setup();
    render(<CodingWorkbench cwd="/repo" models={[]} />);
    await screen.findByTestId("file-tree");

    await user.click(screen.getByRole("button", { name: "搜索" }));
    expect(screen.getByLabelText("搜索代码")).toBeInTheDocument();
    expect(screen.queryByTestId("file-tree")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "上下文包" }));
    expect(screen.getByText(/未选定时由 Agent 自行检索/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "资源管理器" }));
    expect(screen.getByTestId("file-tree")).toBeInTheDocument();
  });

  it("pins and unpins the open file as task context", async () => {
    const user = userEvent.setup();
    render(<CodingWorkbench cwd="/repo" models={[]} />);
    await screen.findByTestId("file-tree");

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

    await user.click(screen.getByRole("button", { name: "上下文包" }));
    await user.click(screen.getByRole("button", { name: /将当前文件加入上下文/ }));
    // The remove control only exists once the path is pinned.
    expect(screen.getByRole("button", { name: "移除 src/a.ts" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "移除 src/a.ts" }));
    expect(screen.getByText(/未选定时由 Agent 自行检索/)).toBeInTheDocument();
  });

  it("creates a task, records the baseline and submits it to the orchestrator", async () => {
    const user = userEvent.setup();
    const onStartRun = vi.fn(async () => "session-1");
    invoke.mockImplementation(async (command: string) => {
      if (command === "coding_task_create") {
        return {
          id: "t1",
          name: "增加登录审计",
          requirement: "增加登录审计",
          phase: "idle",
          acceptanceCriteria: [],
          taskNodes: [],
          planRequired: false,
          createdAt: "",
          updatedAt: "",
        };
      }
      if (command === "coding_task_list") return [];
      return null;
    });

    render(
      <CodingWorkbench
        cwd="/repo"
        models={[{ id: "m1" }]}
        defaultModelId="m1"
        apiReady
        onStartRun={onStartRun}
      />,
    );
    await screen.findByLabelText("开发需求");

    await user.type(screen.getByLabelText("开发需求"), "增加登录审计");
    await user.click(screen.getByRole("button", { name: "开始开发任务" }));

    const invoked = invoke.mock.calls.map((call) => call[0]);
    expect(invoked).toContain("coding_task_create");
    // The baseline must be captured before the Agent starts writing.
    expect(invoked).toContain("coding_changeset_capture_baseline");
    expect(invoked).toContain("coding_task_submit_requirement");
    expect(onStartRun).toHaveBeenCalledWith("/repo", "增加登录审计", false, "m1");
  });

  it("offers the task starter until a task exists", async () => {
    render(<CodingWorkbench cwd="/repo" models={[{ id: "m1" }]} defaultModelId="m1" apiReady />);
    expect(await screen.findByLabelText("开发需求")).toBeInTheDocument();
    expect(screen.queryByLabelText("给 Agent 的补充要求")).not.toBeInTheDocument();
  });

  it("toggles the bottom panel with its shortcut", async () => {
    const user = userEvent.setup();
    render(<CodingWorkbench cwd="/repo" models={[]} />);
    await screen.findByRole("navigation", { name: "活动栏" });
    expect(screen.queryByRole("tablist", { name: "开发工具面板" })).not.toBeInTheDocument();

    await user.keyboard("{Meta>}j{/Meta}");
    expect(screen.getByRole("tablist", { name: "开发工具面板" })).toBeInTheDocument();

    await user.keyboard("{Meta>}j{/Meta}");
    expect(screen.queryByRole("tablist", { name: "开发工具面板" })).not.toBeInTheDocument();
  });

  it("detects the project's verification commands on open", async () => {
    invoke.mockImplementation(async (command: string): Promise<unknown> => {
      if (command === "coding_verification_detect") {
        return [{ kind: "test", command: "pnpm test", label: "测试" }];
      }
      if (command === "coding_task_list") return [];
      return null;
    });
    render(<CodingWorkbench cwd="/repo" models={[]} />);
    await screen.findByRole("navigation", { name: "活动栏" });
    await waitFor(() =>
      expect(invoke.mock.calls.map((call) => call[0])).toContain("coding_verification_detect"),
    );
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
