import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async (command: string, _args?: unknown): Promise<unknown> => {
  if (command === "coding_task_list") return [];
  if (command === "coding_verification_detect") return [];
  return null;
});
const eventListeners = new Map<string, (event: { payload: unknown }) => void>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args: unknown) => invoke(command, args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, callback: (event: { payload: unknown }) => void) => {
    eventListeners.set(name, callback);
    return () => {
      if (eventListeners.get(name) === callback) eventListeners.delete(name);
    };
  }),
}));
vi.mock("@/components/workspace-panel/FileTreeView", () => ({
  FileTreeView: ({
    rootPath,
    onFileSelect,
  }: {
    rootPath: string;
    onFileSelect: (path: string) => void;
  }) => (
    <div data-testid="file-tree">
      <button type="button" onClick={() => onFileSelect(`${rootPath}/src/a.ts`)}>
        打开源文件
      </button>
    </div>
  ),
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
import type { CodingTask, VerificationRecord } from "../lib/types";
import { useTabStore } from "../store/tab-store";
import { useTaskStore } from "../store/task-store";
import { useWorkbenchStore } from "../store/workbench-store";
import { useClipboardStore } from "../store/clipboard-store";
import { useFileTreeSelectionStore } from "../store/file-tree-selection-store";

function verificationTask(overrides: Partial<CodingTask> = {}): CodingTask {
  return {
    schemaVersion: 2,
    id: "verification-task",
    name: "验证布局",
    requirement: "验证工作台布局",
    phase: "verifying",
    acceptanceCriteria: [],
    taskNodes: [],
    planIssues: [],
    globalConstraints: [],
    createdAt: "2026-09-13T00:00:00Z",
    updatedAt: "2026-09-13T00:00:01Z",
    ...overrides,
  };
}

async function emitTauriEvent(name: string, payload: unknown) {
  await waitFor(() => expect(eventListeners.has(name)).toBe(true));
  await act(async () => {
    eventListeners.get(name)?.({ payload });
  });
}

describe("CodingWorkbench skeleton", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "?legacy-coding");
    localStorage.clear();
    invoke.mockReset();
    invoke.mockImplementation(async (command: string): Promise<unknown> => {
      if (command === "coding_task_list") return [];
      if (command === "coding_verification_detect") return [];
      return null;
    });
    eventListeners.clear();
    readDocument.mockReset();
    readDocument.mockImplementation(async (_root: string, path: string) => ({
      path,
      relativePath: path.replace("/repo/", ""),
      content: "disk content",
      hash: "h1",
      size: 12,
      modifiedAt: 0,
      language: "typescript",
      lineEnding: "LF" as const,
    }));
    writeDocument.mockReset();
    writeDocument.mockImplementation(async (
      _root: string,
      path: string,
      content: string,
      _hash?: string,
    ) => ({
      path,
      relativePath: path.replace("/repo/", ""),
      content,
      hash: "h2",
      size: content.length,
      modifiedAt: 0,
      language: "typescript",
      lineEnding: "LF" as const,
    }));
    useTabStore.getState().closeAll();
    useClipboardStore.getState().clear();
    useFileTreeSelectionStore.getState().clear();
    useWorkbenchStore.getState().resetLayout();
    useTaskStore.setState({
      root: "",
      summaries: [],
      task: null,
      changeSet: null,
      verifications: [],
      problems: [],
      orchestrator: null,
      loading: false,
      error: null,
    });
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
    expect(screen.getByRole("contentinfo", { name: "工作台状态" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "切换项目" })).toHaveTextContent("repo");
    expect(screen.getByText("项目根目录")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "切换开发任务" })).toHaveTextContent("新建任务");
    expect(screen.getByRole("contentinfo", { name: "工作台状态" })).toHaveTextContent("Agent 就绪");
  });

  it("执行中的任务会阻止切换项目，避免丢失任务上下文", async () => {
    const user = userEvent.setup();
    const onSelectWorkspace = vi.fn();
    const onToast = vi.fn();
    render(
      <CodingWorkbench
        cwd="/repo"
        models={[]}
        codingWorkspaces={[{ cwd: "/repo" }, { cwd: "/other" }]}
        activeCodingWorkspaceCwd="/repo"
        onSelectWorkspace={onSelectWorkspace}
        onToast={onToast}
      />,
    );
    await screen.findByRole("navigation", { name: "活动栏" });
    act(() => useTaskStore.setState({ task: verificationTask({ phase: "implementing" }) }));

    await user.click(screen.getByRole("button", { name: "切换项目" }));
    await user.click(screen.getByRole("menuitem", { name: "切换到项目 other" }));

    expect(onSelectWorkspace).not.toHaveBeenCalled();
    expect(onToast).toHaveBeenCalledWith("当前开发任务仍在执行，请先停止任务再切换项目");
  });

  it("从资源管理器打开源文件并显示可编辑内容", async () => {
    const user = userEvent.setup();
    render(<CodingWorkbench cwd="/repo" models={[]} />);

    await user.click(await screen.findByRole("button", { name: "打开源文件" }));

    expect(await screen.findByTestId("editor")).toHaveTextContent("disk content");
    expect(useTabStore.getState().tabs[0]).toMatchObject({
      id: "/repo/src/a.ts",
      relativePath: "src/a.ts",
      language: "typescript",
      loading: false,
      error: undefined,
    });
  });

  it("文件读取失败后可从错误态直接重试", async () => {
    const user = userEvent.setup();
    readDocument
      .mockRejectedValueOnce(new Error("temporary read failure"))
      .mockImplementationOnce(async (_root: string, path: string) => ({
        path,
        relativePath: "src/a.ts",
        content: "recovered content",
        hash: "recovered-hash",
        size: 17,
        modifiedAt: 0,
        language: "typescript",
        lineEnding: "LF" as const,
      }));

    render(<CodingWorkbench cwd="/repo" models={[]} />);
    await user.click(await screen.findByRole("button", { name: "打开源文件" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "打开失败：temporary read failure",
    );

    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByTestId("editor")).toHaveTextContent("recovered content");
    expect(readDocument).toHaveBeenCalledTimes(2);
  });

  it("工作区切换中断加载后可重试，且过期响应不会覆盖新内容", async () => {
    const user = userEvent.setup();
    let resolveFirst!: (value: Awaited<ReturnType<typeof readDocument>>) => void;
    const firstRead = new Promise<Awaited<ReturnType<typeof readDocument>>>((resolve) => {
      resolveFirst = resolve;
    });
    readDocument
      .mockImplementationOnce(() => firstRead)
      .mockImplementationOnce(async (_root: string, path: string) => ({
        path,
        relativePath: "src/a.ts",
        content: "fresh content",
        hash: "fresh-hash",
        size: 13,
        modifiedAt: 0,
        language: "typescript",
        lineEnding: "LF" as const,
      }));

    const { rerender } = render(<CodingWorkbench cwd="/repo" models={[]} />);
    await user.click(await screen.findByRole("button", { name: "打开源文件" }));
    expect(await screen.findByText("正在打开…")).toBeInTheDocument();

    rerender(<CodingWorkbench cwd="/other" models={[]} />);
    expect(await screen.findByText(/从资源管理器打开文件/)).toBeInTheDocument();
    rerender(<CodingWorkbench cwd="/repo" models={[]} />);
    expect(await screen.findByText("正在打开…")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "打开源文件" }));
    expect(await screen.findByTestId("editor")).toHaveTextContent("fresh content");
    expect(readDocument).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveFirst({
        path: "/repo/src/a.ts",
        relativePath: "src/a.ts",
        content: "stale content",
        hash: "stale-hash",
        size: 13,
        modifiedAt: 0,
        language: "typescript",
        lineEnding: "LF",
      });
      await firstRead;
    });
    expect(screen.getByTestId("editor")).toHaveTextContent("fresh content");
    expect(useTabStore.getState().tabs[0]).toMatchObject({
      draft: "fresh content",
      hash: "fresh-hash",
      loading: false,
    });
  });

  it("exposes draggable separators for both side panes", async () => {
    render(<CodingWorkbench cwd="/repo" models={[]} />);
    const separators = await screen.findAllByRole("separator");
    const labels = separators.map((node) => node.getAttribute("aria-label"));
    expect(labels).toContain("调整资源管理器宽度");
    expect(labels).toContain("调整 Agent 面板宽度");
    expect(screen.getByRole("separator", { name: "调整资源管理器宽度" }))
      .toHaveClass("coding-workbench__vsplit--explorer");
    expect(screen.getByRole("separator", { name: "调整 Agent 面板宽度" }))
      .toHaveClass("coding-workbench__vsplit--agent");
  });

  it("resizes side panes by pointer delta instead of absolute window coordinates", async () => {
    render(<CodingWorkbench cwd="/repo" models={[]} />);
    const explorerSeparator = await screen.findByRole("separator", {
      name: "调整资源管理器宽度",
    });
    fireEvent.pointerDown(explorerSeparator, { clientX: 300 });
    fireEvent.pointerMove(window, { clientX: 340 });
    fireEvent.pointerUp(window);
    expect(useWorkbenchStore.getState().explorerWidth).toBe(278);

    const agentSeparator = screen.getByRole("separator", { name: "调整 Agent 面板宽度" });
    fireEvent.pointerDown(agentSeparator, { clientX: 900 });
    fireEvent.pointerMove(window, { clientX: 940 });
    fireEvent.pointerUp(window);
    expect(useWorkbenchStore.getState().agentWidth).toBe(340);
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
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

  it("does not apply file-tree mutation shortcuts while typing", async () => {
    render(<CodingWorkbench cwd="/repo" models={[]} />);
    const input = await screen.findByRole("textbox", { name: "任务描述" });
    useFileTreeSelectionStore.getState().select(["/repo/src/a.ts"]);

    fireEvent.keyDown(input, { key: "Backspace" });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

    fireEvent.keyDown(input, { key: "c", metaKey: true });
    expect(useClipboardStore.getState().paths).toEqual([]);
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

  it("loads the current task diff from the toolbar and keeps it fresh after Agent writes", async () => {
    const user = userEvent.setup();
    const activeTask = verificationTask({
      id: "task-1",
      phase: "implementing",
      name: "修改问候语",
    });
    const taskChangeSet = {
      taskId: activeTask.id,
      baselineMode: "filesystem" as const,
      changes: [{
        path: "src/a.ts",
        kind: "modified" as const,
        added: 1,
        removed: 1,
        preExisting: false,
      }],
      createdAt: "2026-09-13T00:00:00Z",
      reviewedFiles: [],
      rollbackUnsafeFiles: [],
      committedHash: null,
    };
    let modified = "task version 1";
    useTaskStore.setState({ root: "/repo", task: activeTask, changeSet: taskChangeSet });
    invoke.mockImplementation(async (command: string): Promise<unknown> => {
      if (command === "coding_task_list" || command === "coding_verification_detect") return [];
      if (command === "coding_changeset_diff") {
        return { original: "task baseline", modified, binary: false };
      }
      if (command === "coding_changeset_get") return { ...taskChangeSet };
      if (command === "coding_verification_list" || command === "coding_diagnostics_list") return [];
      if (command === "coding_orchestrator_state") {
        return {
          schemaVersion: 2,
          task: activeTask,
          problems: [],
          repairRounds: [],
          changedFileCount: 1,
          maxRepairRounds: 3,
        };
      }
      return null;
    });
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
    await user.click(await screen.findByRole("button", { name: "差异" }));

    await waitFor(() => expect(screen.getByTestId("editor")).toHaveTextContent("task version 1"));
    expect(invoke).toHaveBeenCalledWith("coding_changeset_diff", {
      root: "/repo",
      taskId: activeTask.id,
      path: "src/a.ts",
    });
    expect(useTabStore.getState().tabs.find((tab) => tab.id === "/repo/src/a.ts"))
      .toMatchObject({
        view: "diff",
        diffOriginal: "task baseline",
        diffModified: "task version 1",
        diffTaskId: activeTask.id,
      });

    const callsBeforeWrite = invoke.mock.calls.filter(
      ([command]) => command === "coding_changeset_diff",
    ).length;
    modified = "task version 2";
    readDocument.mockResolvedValue({
      path: "/repo/src/a.ts",
      relativePath: "src/a.ts",
      content: "task version 2",
      hash: "h2",
      size: 14,
      modifiedAt: 1,
      language: "typescript",
      lineEnding: "LF" as const,
    });
    await emitTauriEvent("coding://file-updated", { root: "/repo", file: "src/a.ts" });

    await waitFor(() => expect(screen.getByTestId("editor")).toHaveTextContent("task version 2"));
    expect(invoke.mock.calls.filter(([command]) => command === "coding_changeset_diff").length)
      .toBeGreaterThan(callsBeforeWrite);
  });

  it("回滚仅恢复任务文件，并保留无关标签和未保存草稿", async () => {
    const user = userEvent.setup();
    const activeTask = verificationTask({ id: "task-rollback", phase: "stopped" });
    const taskChangeSet = {
      taskId: activeTask.id,
      baselineMode: "filesystem" as const,
      changes: [{
        path: "src/a.ts",
        kind: "modified" as const,
        added: 1,
        removed: 1,
        preExisting: false,
      }],
      createdAt: "2026-09-13T00:00:00Z",
      reviewedFiles: [],
      rollbackUnsafeFiles: [],
      committedHash: null,
    };
    useTaskStore.setState({ root: "/repo", task: activeTask, changeSet: taskChangeSet });
    readDocument.mockImplementation(async (_root: string, path: string) => ({
      path,
      relativePath: path.replace("/repo/", ""),
      content: "restored baseline",
      hash: "restored-hash",
      size: 17,
      modifiedAt: 1,
      language: "typescript",
      lineEnding: "LF" as const,
    }));
    invoke.mockImplementation(async (command: string): Promise<unknown> => {
      if (command === "coding_task_list" || command === "coding_verification_detect") return [];
      if (command === "coding_task_rollback") return ["src/a.ts"];
      if (command === "coding_changeset_get") return { ...taskChangeSet, changes: [] };
      if (
        command === "coding_verification_list"
        || command === "coding_diagnostics_list"
        || command === "coding_task_execution_ledger"
      ) return [];
      if (command === "coding_orchestrator_state") return null;
      return null;
    });

    render(<CodingWorkbench cwd="/repo" models={[]} />);
    await screen.findByRole("navigation", { name: "活动栏" });
    act(() => {
      useTabStore.getState().openFile({
        id: "/repo/src/a.ts",
        relativePath: "src/a.ts",
        name: "a.ts",
        language: "typescript",
        original: "task version",
        draft: "unsaved task draft",
        hash: "task-hash",
        loading: false,
      });
      useTabStore.getState().openFile({
        id: "/repo/notes.txt",
        relativePath: "notes.txt",
        name: "notes.txt",
        language: "plaintext",
        original: "notes",
        draft: "private draft",
        hash: "notes-hash",
        loading: false,
      });
    });

    await user.click(screen.getByRole("button", { name: "任务变更" }));
    await user.click(screen.getByRole("button", { name: /回滚任务/ }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent(/其他标签和草稿会保留/);
    await user.click(within(dialog).getByRole("button", { name: "回滚任务" }));

    await waitFor(() => expect(readDocument).toHaveBeenCalledWith("/repo", "/repo/src/a.ts"));
    expect(useTabStore.getState().tabs.find((tab) => tab.id === "/repo/src/a.ts"))
      .toMatchObject({ original: "restored baseline", draft: "restored baseline" });
    expect(useTabStore.getState().tabs.find((tab) => tab.id === "/repo/notes.txt"))
      .toMatchObject({ original: "notes", draft: "private draft" });
  });

  it("explains when the active file has no task or local diff", async () => {
    const user = userEvent.setup();
    const onToast = vi.fn();
    const activeTask = verificationTask({ id: "task-1", phase: "implementing" });
    useTaskStore.setState({ root: "/repo", task: activeTask });
    invoke.mockImplementation(async (command: string): Promise<unknown> => {
      if (command === "coding_task_list" || command === "coding_verification_detect") return [];
      if (command === "coding_changeset_diff") {
        throw new Error("该文件不在当前任务变更集中");
      }
      return null;
    });
    render(<CodingWorkbench cwd="/repo" models={[]} onToast={onToast} />);
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
    await user.click(await screen.findByRole("button", { name: "差异" }));

    await waitFor(() => expect(onToast).toHaveBeenCalledWith(
      "当前文件不在当前任务变更中，也没有未保存修改",
    ));
    expect(useTabStore.getState().tabs.find((tab) => tab.id === "/repo/src/a.ts"))
      .toMatchObject({ view: "edit", diffOriginal: undefined, diffModified: undefined });
  });

  it("does not switch back to diff after the user cancels an in-flight load", async () => {
    const user = userEvent.setup();
    const activeTask = verificationTask({ id: "task-1", phase: "implementing" });
    let resolveDiff!: (diff: { original: string; modified: string; binary: boolean }) => void;
    const pendingDiff = new Promise<{ original: string; modified: string; binary: boolean }>(
      (resolve) => { resolveDiff = resolve; },
    );
    useTaskStore.setState({ root: "/repo", task: activeTask });
    invoke.mockImplementation(async (command: string): Promise<unknown> => {
      if (command === "coding_task_list" || command === "coding_verification_detect") return [];
      if (command === "coding_changeset_diff") return pendingDiff;
      return null;
    });
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
    await user.click(await screen.findByRole("button", { name: "差异" }));
    expect(await screen.findByRole("button", { name: "正在加载最新差异" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "编辑" }));
    await act(async () => {
      resolveDiff({ original: "before", modified: "after", binary: false });
      await pendingDiff;
    });

    await waitFor(() => expect(useTabStore.getState().tabs.find(
      (tab) => tab.id === "/repo/src/a.ts",
    )).toMatchObject({ view: "edit" }));
    expect(screen.getByRole("button", { name: "差异" })).toBeEnabled();
  });

  it("refreshes an open HTML tab after an external or Agent write", async () => {
    readDocument.mockResolvedValueOnce({
      path: "/repo/hello_world.html",
      relativePath: "hello_world.html",
      content: "<!-- updated -->\n<h1>Hello</h1>",
      hash: "h2",
      size: 37,
      modifiedAt: 1,
      language: "html",
      lineEnding: "LF" as const,
    });
    render(<CodingWorkbench cwd="/repo" models={[]} />);
    await screen.findByRole("navigation", { name: "活动栏" });
    await act(async () => {
      useTabStore.getState().openFile({
        id: "/repo/hello_world.html",
        relativePath: "hello_world.html",
        name: "hello_world.html",
        language: "html",
        original: "<h1>Hello</h1>",
        draft: "<h1>Hello</h1>",
        hash: "h1",
        loading: false,
      });
    });

    await emitTauriEvent("coding://file-updated", {
      root: "/repo",
      file: "hello_world.html",
    });

    await waitFor(() => expect(screen.getByTestId("editor")).toHaveTextContent("updated"));
    expect(useTabStore.getState().tabs.find((tab) => tab.id === "/repo/hello_world.html"))
      .toMatchObject({ hash: "h2", conflict: false });
  });

  it("preserves an unsaved draft and marks a conflict after an Agent write", async () => {
    readDocument.mockResolvedValueOnce({
      path: "/repo/hello_world.html",
      relativePath: "hello_world.html",
      content: "<!-- Agent edit -->\n<h1>Hello</h1>",
      hash: "h2",
      size: 39,
      modifiedAt: 1,
      language: "html",
      lineEnding: "LF" as const,
    });
    render(<CodingWorkbench cwd="/repo" models={[]} />);
    await screen.findByRole("navigation", { name: "活动栏" });
    await act(async () => {
      useTabStore.getState().openFile({
        id: "/repo/hello_world.html",
        relativePath: "hello_world.html",
        name: "hello_world.html",
        language: "html",
        original: "<h1>Hello</h1>",
        draft: "<h1>Hello</h1>",
        hash: "h1",
        loading: false,
      });
      useTabStore.getState().updateDraft("/repo/hello_world.html", "<h1>My draft</h1>");
    });

    await emitTauriEvent("coding://file-updated", {
      root: "/repo",
      file: "hello_world.html",
    });

    await waitFor(() => expect(screen.getByRole("alert"))
      .toHaveTextContent(/已被 Agent 或其他程序修改/));
    expect(screen.getByTestId("editor")).toHaveTextContent("My draft");
    expect(useTabStore.getState().tabs.find((tab) => tab.id === "/repo/hello_world.html"))
      .toMatchObject({ draft: "<h1>My draft</h1>", hash: "h1", conflict: true });
  });

  it("uses the synchronized ChangeSet as a missed-event refresh fallback", async () => {
    readDocument.mockResolvedValueOnce({
      path: "/repo/hello_world.html",
      relativePath: "hello_world.html",
      content: "<!-- synchronized -->\n<h1>Hello</h1>",
      hash: "h2",
      size: 42,
      modifiedAt: 1,
      language: "html",
      lineEnding: "LF" as const,
    });
    render(<CodingWorkbench cwd="/repo" models={[]} />);
    await screen.findByRole("navigation", { name: "活动栏" });
    await act(async () => {
      useTabStore.getState().openFile({
        id: "/repo/hello_world.html",
        relativePath: "hello_world.html",
        name: "hello_world.html",
        language: "html",
        original: "<h1>Hello</h1>",
        draft: "<h1>Hello</h1>",
        hash: "h1",
        loading: false,
      });
      useTaskStore.setState({
        changeSet: {
          taskId: "task-1",
          baselineMode: "filesystem",
          changes: [{
            path: "hello_world.html",
            kind: "modified",
            added: 1,
            removed: 0,
            preExisting: false,
          }],
          createdAt: "2026-09-13T00:00:00Z",
          reviewedFiles: [],
          rollbackUnsafeFiles: [],
          committedHash: null,
        },
      });
    });

    await waitFor(() => expect(screen.getByTestId("editor")).toHaveTextContent("synchronized"));
    expect(readDocument).toHaveBeenCalledWith("/repo", "/repo/hello_world.html");
  });

  it("shows a removed-file state without discarding unsaved content", async () => {
    render(<CodingWorkbench cwd="/repo" models={[]} />);
    await screen.findByRole("navigation", { name: "活动栏" });
    await act(async () => {
      useTabStore.getState().openFile({
        id: "/repo/hello_world.html",
        relativePath: "hello_world.html",
        name: "hello_world.html",
        language: "html",
        original: "<h1>Hello</h1>",
        draft: "<h1>Unsaved</h1>",
        hash: "h1",
        loading: false,
      });
    });

    await emitTauriEvent("coding://file-removed", {
      root: "/repo",
      file: "hello_world.html",
    });

    await waitFor(() => expect(screen.getByRole("alert"))
      .toHaveTextContent(/已被 Agent 或其他程序修改/));
    expect(screen.getByTestId("editor")).toHaveTextContent("Unsaved");
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
          planIssues: [],
          globalConstraints: [],
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
    await screen.findByLabelText("任务描述");

    await user.type(screen.getByLabelText("任务描述"), "增加登录审计");
    await user.click(screen.getByRole("button", { name: "开始 Agent 任务" }));

    const invoked = invoke.mock.calls.map((call) => call[0]);
    expect(invoked).toContain("coding_task_create");
    // The baseline must be captured before the Agent starts writing.
    expect(invoked).toContain("coding_changeset_capture_baseline");
    expect(invoked).toContain("coding_task_submit_requirement");
    expect(invoke).toHaveBeenCalledWith("coding_task_submit_requirement", {
      root: "/repo",
      taskId: "t1",
    });
    expect(onStartRun).toHaveBeenCalledWith(
      "/repo",
      "增加登录审计",
      "m1",
      [],
      expect.any(Function),
    );
    const baselineCall = invoke.mock.calls.findIndex(
      (call) => call[0] === "coding_changeset_capture_baseline",
    );
    expect(invoke.mock.invocationCallOrder[baselineCall])
      .toBeLessThan(onStartRun.mock.invocationCallOrder[0]);
  });

  it("starts evidence-scoped comment generation directly from the editor toolbar", async () => {
    const user = userEvent.setup();
    const onStartRun = vi.fn(async (..._args: unknown[]) => "session-doc");
    invoke.mockImplementation(async (command: string) => {
      if (command === "coding_task_create") {
        return {
          schemaVersion: 2,
          id: "t-doc",
          name: "生成注释",
          requirement: "生成注释",
          phase: "idle",
          acceptanceCriteria: [],
          taskNodes: [],
          planIssues: [],
          globalConstraints: [],
          createdAt: "",
          updatedAt: "",
        };
      }
      if (command === "coding_task_list" || command === "coding_verification_detect") return [];
      if (command === "coding_symbol_at") return null;
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
    await screen.findByTestId("file-tree");
    await act(async () => {
      useTabStore.getState().openFile({
        id: "/repo/src/a.ts",
        relativePath: "src/a.ts",
        name: "a.ts",
        language: "typescript",
        original: "export function total() { return 1; }",
        draft: "export function total() { return 1; }",
        hash: "h1",
        loading: false,
      });
    });

    await user.click(screen.getByRole("button", {
      name: "为当前选区或符号生成注释",
    }));

    await waitFor(() => expect(onStartRun).toHaveBeenCalledWith(
      "/repo",
      expect.stringContaining("src/a.ts"),
      "m1",
      ["src/a.ts"],
      expect.any(Function),
      expect.stringContaining("[回声代码·分层文档协议]"),
    ));
    expect(onStartRun.mock.calls[0]?.[5]).toContain("粒度：module");
    expect(onStartRun.mock.calls[0]?.[5]).toContain("禁止改变可执行逻辑");
  });

  it("starts a task in an ordinary folder without requiring Git", async () => {
    const user = userEvent.setup();
    const onStartRun = vi.fn(async () => "session-1");
    invoke.mockImplementation(async (command: string) => {
      if (command === "coding_task_create") {
        return {
          schemaVersion: 2,
          id: "t-local",
          name: "清除 HTML 注释",
          requirement: "清除 HTML 注释",
          phase: "idle",
          acceptanceCriteria: [],
          taskNodes: [],
          planIssues: [],
          globalConstraints: [],
          createdAt: "",
          updatedAt: "",
        };
      }
      if (command === "coding_task_list") return [];
      return null;
    });

    render(
      <CodingWorkbench
        cwd="/plain-folder"
        models={[{ id: "m1" }]}
        defaultModelId="m1"
        apiReady
        onStartRun={onStartRun}
      />,
    );
    const requirement = await screen.findByLabelText("任务描述");
    await user.type(requirement, "清除 HTML 注释");
    await user.click(screen.getByRole("button", { name: "开始 Agent 任务" }));

    const invoked = invoke.mock.calls.map((call) => call[0]);
    expect(invoked).toContain("coding_task_create");
    expect(invoked).toContain("coding_changeset_capture_baseline");
    expect(invoked).not.toContain("coding_changeset_validate_repository");
    expect(onStartRun).toHaveBeenCalledWith(
      "/plain-folder",
      "清除 HTML 注释",
      "m1",
      [],
      expect.any(Function),
      expect.stringContaining("[回声代码·分层文档协议]"),
    );
  });

  it("offers the task starter until a task exists", async () => {
    render(<CodingWorkbench cwd="/repo" models={[{ id: "m1" }]} defaultModelId="m1" apiReady />);
    expect(await screen.findByLabelText("任务描述")).toBeInTheDocument();
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

  it("asks before running verification commands declared by structured plan nodes", async () => {
    const user = userEvent.setup();
    const verifying = verificationTask({
      taskNodes: [{
        id: "node-1",
        planKey: "T1",
        content: "验证登录模块",
        dependencies: [],
        relatedFiles: ["src/auth.ts"],
        readSet: [],
        writeSet: ["src/auth.ts"],
        consumes: [],
        produces: ["AuthService"],
        acceptanceCriteria: ["登录测试通过"],
        verificationCommands: ["pnpm test -- auth"],
        status: "success",
        priority: "high",
        attempt: 1,
      }],
    });
    const delivered = verificationTask({ phase: "delivered", updatedAt: "later" });
    useTaskStore.setState({ root: "/repo", task: verifying });
    invoke.mockImplementation(async (command: string, args?: unknown): Promise<unknown> => {
      if (command === "coding_task_list" || command === "coding_verification_detect") return [];
      if (command === "coding_task_begin_verification") return verifying;
      if (command === "coding_verification_approve_plan_command") return "approval-token";
      if (command === "coding_verification_run") {
        return {
          id: "planned-check",
          taskId: verifying.id,
          kind: "test",
          command: (args as { command: string }).command,
          status: "passed",
          exitCode: 0,
          stdout: "ok",
          stderr: "",
          durationMs: 1,
          startedAt: "now",
          finishedAt: "later",
          structured: false,
        } satisfies VerificationRecord;
      }
      if (command === "coding_changeset_get") return null;
      if (
        command === "coding_verification_list"
        || command === "coding_diagnostics_list"
        || command === "coding_task_execution_ledger"
      ) return [];
      if (command === "coding_orchestrator_state") {
        return { task: delivered, problems: [], repairRounds: [], changedFileCount: 1, maxRepairRounds: 3 };
      }
      if (command === "coding_orchestrator_report_verification") return delivered;
      return null;
    });

    render(<CodingWorkbench cwd="/repo" models={[]} />);
    expect(await screen.findByRole("alertdialog", {
      name: "确认运行计划中的验证命令",
    })).toBeInTheDocument();
    expect(invoke.mock.calls.map((call) => call[0])).not.toContain("coding_verification_run");
    await user.click(screen.getByRole("button", { name: "确认并运行" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      "coding_verification_run",
      expect.objectContaining({
        command: "pnpm test -- auth",
        kind: "test",
        approvalToken: "approval-token",
      }),
    ));
  });

  it("blocks cleanly when a verification command cannot be started", async () => {
    const verifying = verificationTask();
    const blocked = verificationTask({
      phase: "blocked",
      blocker: "验证命令无法执行",
      updatedAt: "2026-09-13T00:00:02Z",
    });
    useTaskStore.setState({ root: "/repo", task: verifying });
    invoke.mockImplementation(async (command: string): Promise<unknown> => {
      if (command === "coding_task_list") return [];
      if (command === "coding_verification_detect") {
        return [{ kind: "test", command: "pnpm test", label: "测试" }];
      }
      if (command === "coding_task_begin_verification") return verifying;
      if (command === "coding_verification_run") throw new Error("command rejected");
      if (command === "coding_task_report_start_failed") return blocked;
      if (command === "coding_changeset_get") return null;
      if (
        command === "coding_verification_list"
        || command === "coding_diagnostics_list"
        || command === "coding_task_execution_ledger"
      ) return [];
      if (command === "coding_orchestrator_state") {
        return { task: blocked, problems: [], repairRounds: [], changedFileCount: 1, maxRepairRounds: 3 };
      }
      return null;
    });

    render(<CodingWorkbench cwd="/repo" models={[]} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      "coding_task_report_start_failed",
      expect.objectContaining({
        taskId: verifying.id,
        reason: expect.stringContaining("验证命令“pnpm test”未能执行"),
      }),
    ));
    await waitFor(() => expect(useTaskStore.getState().task?.phase).toBe("blocked"));
  });

  it("continues the exact node selected by the persisted backend scheduler", async () => {
    const onSendMessage = vi.fn(async (_text: string, _prompt?: string) => true);
    const scheduled = verificationTask({
      phase: "implementing",
      sessionId: "s1",
      nextAction: "continue_node",
      taskNodes: [{
        id: "node-2",
        planKey: "T2",
        content: "实现订单 API",
        dependencies: ["T1"],
        relatedFiles: ["src/order-api.ts"],
        readSet: ["src/order.ts"],
        writeSet: ["src/order-api.ts"],
        consumes: ["OrderService"],
        produces: ["OrderApi"],
        acceptanceCriteria: ["API 可创建订单"],
        verificationCommands: ["pnpm test -- order-api"],
        status: "running",
        priority: "high",
        attempt: 1,
      }],
    });
    useTaskStore.setState({ root: "/repo", task: scheduled });
    render(
      <CodingWorkbench
        cwd="/repo"
        sessionId="s1"
        models={[{ id: "m1" }]}
        onSendMessage={onSendMessage}
      />,
    );
    await waitFor(() => expect(onSendMessage).toHaveBeenCalled());
    expect(onSendMessage.mock.calls[0]?.[0]).toBe("继续执行 T2");
    expect(onSendMessage.mock.calls[0]?.[1]).toContain("只继续下面这个由调度器选中的节点");
    expect(onSendMessage.mock.calls[0]?.[1]).toContain("Files: src/order-api.ts");
  });

  it("keeps an empty output panel closed when automatic verification has no commands", async () => {
    const verifying = verificationTask();
    const delivered = verificationTask({
      phase: "delivered",
      updatedAt: "2026-09-13T00:00:02Z",
    });
    useTaskStore.setState({ root: "/repo", task: verifying });
    invoke.mockImplementation(async (command: string): Promise<unknown> => {
      if (command === "coding_task_list") return [];
      if (command === "coding_verification_detect") return [];
      if (command === "coding_task_begin_verification") return verifying;
      if (command === "coding_changeset_get") return null;
      if (command === "coding_verification_list" || command === "coding_diagnostics_list") return [];
      if (command === "coding_orchestrator_state") {
        return { task: delivered, problems: [], repairRounds: [], changedFileCount: 1, maxRepairRounds: 3 };
      }
      if (command === "coding_orchestrator_report_verification") return delivered;
      return null;
    });

    render(<CodingWorkbench cwd="/repo" models={[]} />);
    await waitFor(() => expect(invoke.mock.calls.map((call) => call[0]))
      .toContain("coding_orchestrator_report_verification"));
    expect(screen.queryByRole("tablist", { name: "开发工具面板" })).not.toBeInTheDocument();
  });

  it("opens output for a real verification command without moving the workbench panes", async () => {
    const verifying = verificationTask();
    const delivered = verificationTask({
      phase: "delivered",
      updatedAt: "2026-09-13T00:00:02Z",
    });
    const record: VerificationRecord = {
      id: "verification-1",
      taskId: verifying.id,
      kind: "test",
      command: "pnpm test",
      status: "passed",
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      durationMs: 10,
      startedAt: "2026-09-13T00:00:01Z",
      finishedAt: "2026-09-13T00:00:02Z",
      testSummary: null,
      structured: false,
    };
    useTaskStore.setState({ root: "/repo", task: verifying });
    invoke.mockImplementation(async (command: string): Promise<unknown> => {
      if (command === "coding_task_list") return [];
      if (command === "coding_verification_detect") {
        return [{ kind: "test", command: "pnpm test", label: "测试" }];
      }
      if (command === "coding_task_begin_verification") return verifying;
      if (command === "coding_verification_run") return record;
      if (command === "coding_changeset_get") return null;
      if (command === "coding_verification_list" || command === "coding_diagnostics_list") return [];
      if (command === "coding_orchestrator_state") {
        return { task: delivered, problems: [], repairRounds: [], changedFileCount: 1, maxRepairRounds: 3 };
      }
      if (command === "coding_orchestrator_report_verification") return delivered;
      return null;
    });

    render(<CodingWorkbench cwd="/repo" models={[]} />);
    expect(await screen.findByRole("tablist", { name: "开发工具面板" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "资源管理器" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Agent 面板" })).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveClass("coding-workbench__main");
  });

  it("isolates and restores open tabs when the workspace changes", async () => {
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

    await act(async () => {
      rerender(<CodingWorkbench cwd="/other" models={[]} />);
    });
    expect(useTabStore.getState().tabs).toHaveLength(0);

    await act(async () => {
      rerender(<CodingWorkbench cwd="/repo" models={[]} />);
    });
    expect(useTabStore.getState().tabs.map((tab) => tab.id)).toEqual(["/repo/src/a.ts"]);
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

describe("CodingWorkbench footer status bar", () => {
  it("renders placeholder when no file is open", async () => {
    window.history.replaceState({}, "", "?legacy-coding");
    render(<CodingWorkbench cwd="/repo" models={[]} />);
    await screen.findByRole("navigation", { name: "活动栏" });
    expect(screen.getAllByText("——").length).toBeGreaterThanOrEqual(3);
  });
});

describe("Theia workbench", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    invoke.mockReset();
    invoke.mockImplementation(async (command: string): Promise<unknown> => {
      if (command === "coding_task_list" || command === "coding_verification_detect") return [];
      if (command === "coding_theia_start") {
        return { url: "http://127.0.0.1:41773/", embedToken: "test-embed-token" };
      }
      return null;
    });
    useTaskStore.setState({
      root: "",
      summaries: [],
      task: null,
      changeSet: null,
      verifications: [],
      problems: [],
      orchestrator: null,
      loading: false,
      error: null,
    });
  });

  it("places the Agent surface inside Theia's right dock", async () => {
    const { container } = render(<CodingWorkbench cwd="/repo" models={[]} />);

    expect(await screen.findByTitle("Echo Code IDE")).toHaveAttribute(
      "src",
      expect.stringContaining("echoEmbedToken=test-embed-token"),
    );
    expect(invoke).toHaveBeenCalledWith("coding_theia_start", { root: "/repo" });
    const agent = container.querySelector(".echo-theia-workspace > .echo-theia-agent") as HTMLElement;
    expect(agent).toBeInTheDocument();
    expect(container.querySelector(".echo-theia-agent__splitter")).not.toBeInTheDocument();

    const frame = screen.getByTitle("Echo Code IDE") as HTMLIFrameElement;
    Object.defineProperty(frame, "clientWidth", { configurable: true, value: 1200 });
    Object.defineProperty(frame, "clientHeight", { configurable: true, value: 900 });
    const src = new URL(frame.src);
    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        origin: src.origin,
        source: frame.contentWindow,
        data: { type: "echo/agent-bounds", token: src.searchParams.get("echoBridgeToken"), bounds: null },
      }));
    });
    expect(container.querySelector(".coding-workbench--agent-closed")).not.toBeInTheDocument();
    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        origin: src.origin,
        source: frame.contentWindow,
        data: {
          type: "echo/agent-bounds",
          token: src.searchParams.get("echoBridgeToken"),
          bounds: { left: 790, top: 44, width: 390, height: 800 },
        },
      }));
    });
    expect(agent).toHaveStyle({ left: "790px", top: "44px", width: "390px", height: "800px" });
    expect(screen.queryByRole("tablist", { name: "开发任务面板" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "任务描述" })).toBeInTheDocument();
    expect(agent.lastElementChild).toHaveClass("echo-theia-agent__composer");
    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        origin: src.origin,
        source: frame.contentWindow,
        data: { type: "echo/agent-bounds", token: src.searchParams.get("echoBridgeToken"), bounds: null },
      }));
    });
    expect(container.querySelector(".coding-workbench--agent-closed")).toBeInTheDocument();
  });

  it("keeps the task composer available while reviewing changes and verification", async () => {
    const user = userEvent.setup();
    useTaskStore.setState({ root: "/repo", task: verificationTask({ phase: "delivered", sessionId: "session-1" }) });
    const { container } = render(<CodingWorkbench cwd="/repo" sessionId="session-1" models={[{ id: "model-1" }]} defaultModelId="model-1" />);
    const frame = await screen.findByTitle("Echo Code IDE") as HTMLIFrameElement;
    Object.defineProperty(frame, "clientWidth", { configurable: true, value: 1200 });
    Object.defineProperty(frame, "clientHeight", { configurable: true, value: 900 });
    const src = new URL(frame.src);
    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        origin: src.origin,
        source: frame.contentWindow,
        data: { type: "echo/agent-bounds", token: src.searchParams.get("echoBridgeToken"), bounds: { left: 790, top: 44, width: 390, height: 800 } },
      }));
    });
    const composer = container.querySelector(".echo-theia-agent__composer");
    const textbox = screen.getByRole("textbox", { name: "给 Agent 的补充要求" });
    fireEvent.change(textbox, { target: { value: "请处理边界情况" } });
    await user.click(screen.getByRole("tab", { name: "变更" }));
    expect(composer).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "给 Agent 的补充要求" })).toHaveValue("请处理边界情况");
    await user.click(screen.getByRole("tab", { name: "验证" }));
    expect(screen.getByRole("textbox", { name: "给 Agent 的补充要求" })).toHaveValue("请处理边界情况");
  });

  it("keeps preview controls compact and lets the editor reclaim the Agent space", async () => {
    const user = userEvent.setup();
    const { container } = render(<CodingWorkbench cwd="/repo" models={[]} />);
    await screen.findByTitle("Echo Code IDE");

    expect(screen.queryByRole("textbox", { name: "网页预览地址" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "网页预览" }));
    expect(screen.getByRole("textbox", { name: "网页预览地址" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: "网页预览地址" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "收起 Agent 面板" }));
    expect(container.querySelector(".coding-workbench--agent-closed")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "展开 Agent 面板" }));
    expect(container.querySelector(".coding-workbench--agent-closed")).not.toBeInTheDocument();
  });
});
