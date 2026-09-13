import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
import type { CodingTask, VerificationRecord } from "../lib/types";
import { useTabStore } from "../store/tab-store";
import { useTaskStore } from "../store/task-store";
import { useWorkbenchStore } from "../store/workbench-store";

function verificationTask(overrides: Partial<CodingTask> = {}): CodingTask {
  return {
    id: "verification-task",
    name: "验证布局",
    requirement: "验证工作台布局",
    phase: "verifying",
    acceptanceCriteria: [],
    taskNodes: [],
    planRequired: false,
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
    localStorage.clear();
    invoke.mockClear();
    eventListeners.clear();
    readDocument.mockClear();
    writeDocument.mockClear();
    useTabStore.getState().closeAll();
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
    expect(screen.getByRole("status", { name: "工作台状态" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "切换开发任务" })).toHaveTextContent("新建任务");
    expect(screen.getByRole("status", { name: "工作台状态" })).toHaveTextContent("Agent 就绪");
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
    expect(onStartRun).toHaveBeenCalledWith(
      "/repo",
      "增加登录审计",
      false,
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

  it("starts a task in an ordinary folder without requiring Git", async () => {
    const user = userEvent.setup();
    const onStartRun = vi.fn(async () => "session-1");
    invoke.mockImplementation(async (command: string) => {
      if (command === "coding_task_create") {
        return {
          id: "t-local",
          name: "清除 HTML 注释",
          requirement: "清除 HTML 注释",
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
        cwd="/plain-folder"
        models={[{ id: "m1" }]}
        defaultModelId="m1"
        apiReady
        onStartRun={onStartRun}
      />,
    );
    const requirement = await screen.findByLabelText("开发需求");
    await user.type(requirement, "清除 HTML 注释");
    await user.click(screen.getByRole("button", { name: "开始开发任务" }));

    const invoked = invoke.mock.calls.map((call) => call[0]);
    expect(invoked).toContain("coding_task_create");
    expect(invoked).toContain("coding_changeset_capture_baseline");
    expect(invoked).not.toContain("coding_changeset_validate_repository");
    expect(onStartRun).toHaveBeenCalledWith(
      "/plain-folder",
      "清除 HTML 注释",
      false,
      "m1",
      [],
      expect.any(Function),
    );
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

  it("keeps an empty output panel closed when automatic verification has no commands", async () => {
    const verifying = verificationTask();
    const gating = verificationTask({ phase: "gating", updatedAt: "2026-09-13T00:00:02Z" });
    useTaskStore.setState({ root: "/repo", task: verifying });
    invoke.mockImplementation(async (command: string): Promise<unknown> => {
      if (command === "coding_task_list") return [];
      if (command === "coding_verification_detect") return [];
      if (command === "coding_task_begin_verification") return verifying;
      if (command === "coding_changeset_get") return null;
      if (command === "coding_verification_list" || command === "coding_diagnostics_list") return [];
      if (command === "coding_orchestrator_state") {
        return { task: gating, problems: [], repairRounds: [], changedFileCount: 1, maxRepairRounds: 3 };
      }
      if (command === "coding_orchestrator_report_verification") return gating;
      return null;
    });

    render(<CodingWorkbench cwd="/repo" models={[]} />);
    await waitFor(() => expect(invoke.mock.calls.map((call) => call[0]))
      .toContain("coding_orchestrator_report_verification"));
    expect(screen.queryByRole("tablist", { name: "开发工具面板" })).not.toBeInTheDocument();
  });

  it("opens output for a real verification command without moving the workbench panes", async () => {
    const verifying = verificationTask();
    const gating = verificationTask({ phase: "gating", updatedAt: "2026-09-13T00:00:02Z" });
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
        return { task: gating, problems: [], repairRounds: [], changedFileCount: 1, maxRepairRounds: 3 };
      }
      if (command === "coding_orchestrator_report_verification") return gating;
      return null;
    });

    render(<CodingWorkbench cwd="/repo" models={[]} />);
    expect(await screen.findByRole("tablist", { name: "开发工具面板" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "资源管理器" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Agent 面板" })).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveClass("coding-workbench__main");
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
