import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CodingWorkspaceAnalysis } from "@/lib/agent-client";
import { useSessionStore } from "@/stores/session-store";
import { useSessionsStore } from "@/stores/sessions-store";
import { usePermissionStore } from "@/stores/permission-store";
import { useQuestionStore, type QuestionRequest } from "@/stores/question-store";

const mocks = vi.hoisted(() => ({
  analyze: vi.fn(),
  gitSnapshot: vi.fn(),
  gitDiff: vi.fn(),
  gitSetStaged: vi.fn(),
  createEntry: vi.fn(),
  runCommand: vi.fn(),
  cancelCommand: vi.fn(),
  listenCommandOutput: vi.fn(),
  readDocument: vi.fn(),
  writeDocument: vi.fn(),
  searchWorkspace: vi.fn(),
  pickDirectory: vi.fn(),
  pathStat: vi.fn(),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  exportTextFile: vi.fn(),
  listPendingInteractions: vi.fn(),
  onQuestionClosed: vi.fn(),
}));

vi.mock("@/lib/agent-client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/agent-client")>();
  return {
    ...original,
    codingAnalyzeWorkspace: mocks.analyze,
    codingGitSnapshot: mocks.gitSnapshot,
    codingGitDiff: mocks.gitDiff,
    codingGitSetStaged: mocks.gitSetStaged,
    codingCreateEntry: mocks.createEntry,
    codingRunCommand: mocks.runCommand,
    codingCancelCommand: mocks.cancelCommand,
    codingListenCommandOutput: mocks.listenCommandOutput,
    codingReadDocument: mocks.readDocument,
    codingWriteDocument: mocks.writeDocument,
    codingSearchWorkspace: mocks.searchWorkspace,
    filesystemPickDirectory: mocks.pickDirectory,
    pathStat: mocks.pathStat,
    readTextFile: mocks.readTextFile,
    writeTextFile: mocks.writeTextFile,
    exportTextFile: mocks.exportTextFile,
    agentListPendingInteractions: mocks.listPendingInteractions,
    onQuestionClosedEvent: mocks.onQuestionClosed,
  };
});

vi.mock("@/components/workspace-panel/FileTreeView", () => ({
  FileTreeView: ({ onFileSelect }: { onFileSelect: (path: string) => void }) => (
    <button type="button" data-testid="file-tree" onClick={() => onFileSelect("/repo/src/app.ts")}>app.ts</button>
  ),
}));
vi.mock("@/components/PlanPanel", () => ({
  PlanPanel: () => <div data-testid="plan-panel">plan panel</div>,
}));
vi.mock("@/components/ExecutionProcess", () => ({
  ExecutionProcess: () => <div data-testid="execution-process">execution</div>,
}));
vi.mock("@/components/coding-workspace/CodingEditor", () => ({
  CodingEditor: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea aria-label="mock code editor" value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));
vi.mock("@/components/coding-workspace/CodingTerminal", () => ({
  CodingTerminal: () => <div data-testid="coding-terminal">terminal</div>,
}));

import { CodingWorkspacePage } from "../coding-workspace/CodingWorkspacePage";

const analysis: CodingWorkspaceAnalysis = {
  root: "/repo",
  name: "commerce",
  projectType: "Node.js",
  fileCount: 126,
  truncated: false,
  languages: [{ language: "TypeScript", files: 88 }],
  modules: [{ name: "commerce", path: ".", kind: "Node.js", dependencies: [] }],
  validationCommands: ["pnpm test"],
  hasGit: true,
  gitBranch: "main",
  gitChangedFiles: 0,
  instructionFiles: ["AGENTS.md"],
  scannedAt: "2026-09-10T00:00:00.000Z",
};

describe("CodingWorkspacePage", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mocks.analyze.mockResolvedValue(analysis);
    mocks.gitSnapshot.mockResolvedValue({
      hasGit: true,
      branch: "main",
      head: "abc123",
      files: [],
      totalAdded: 0,
      totalRemoved: 0,
      capturedAt: "2026-09-10T00:00:00.000Z",
    });
    mocks.gitDiff.mockResolvedValue("");
    mocks.gitSetStaged.mockResolvedValue({
      hasGit: true,
      branch: "main",
      head: "abc123",
      files: [],
      totalAdded: 0,
      totalRemoved: 0,
      capturedAt: "2026-09-10T00:00:00.000Z",
    });
    mocks.createEntry.mockResolvedValue("/repo/new-feature.ts");
    mocks.listenCommandOutput.mockResolvedValue(() => {});
    mocks.cancelCommand.mockResolvedValue(true);
    mocks.readDocument.mockResolvedValue({
      path: "/repo/src/app.ts",
      relativePath: "src/app.ts",
      content: "export const answer = 41;\n",
      hash: "hash-before",
      size: 26,
      modifiedAt: 1,
      language: "typescript",
      lineEnding: "LF",
    });
    mocks.writeDocument.mockResolvedValue({
      path: "/repo/src/app.ts",
      relativePath: "src/app.ts",
      content: "export const answer = 42;\n",
      hash: "hash-after",
      size: 26,
      modifiedAt: 2,
      language: "typescript",
      lineEnding: "LF",
    });
    mocks.searchWorkspace.mockResolvedValue([]);
    mocks.pathStat.mockResolvedValue({ path: "", exists: false, kind: "missing", absolute: "" });
    mocks.runCommand.mockResolvedValue({
      command: "pnpm test",
      stdout: "128 tests passed",
      stderr: "",
      exitCode: 0,
      durationMs: 1200,
      timedOut: false,
      truncated: false,
    });
    mocks.listPendingInteractions.mockResolvedValue({
      permissions: [],
      questions: [],
      planApprovals: [],
      folderTrustRequests: [],
    });
    mocks.onQuestionClosed.mockResolvedValue(() => {});
    useSessionsStore.setState({ currentSessionId: null });
    useSessionStore.setState({ transcripts: {} });
    useSessionStore.getState().reset();
    usePermissionStore.getState().clearAll();
    useQuestionStore.getState().clearAll();
  });

  it("未选择目录时显示清晰的代码库引导", () => {
    render(<CodingWorkspacePage />);
    expect(screen.getByRole("heading", { name: "打开代码库，开始工程级开发" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /选择代码文件夹/ })).toBeInTheDocument();
  });

  it("展示工程分析并将需求、验收标准与执行协议交给 Agent", async () => {
    const user = userEvent.setup();
    const onStartRun = vi.fn().mockResolvedValue("session-coding-1");
    render(
      <CodingWorkspacePage
        cwd="/repo"
        apiReady
        models={[{ id: "model-a", label: "Model A" }]}
        defaultModelId="model-a"
        onStartRun={onStartRun}
        onToast={vi.fn()}
      />,
    );

    expect(await screen.findByText("commerce")).toBeInTheDocument();
    expect(screen.getByText("126")).toBeInTheDocument();
    await user.type(screen.getByLabelText(/开发需求/), "实现取消订单并退款");
    await user.type(screen.getByLabelText(/验收标准/), "库存必须释放\n所有测试通过");
    await user.click(screen.getByRole("radio", { name: /Plan/ }));
    await user.click(screen.getByRole("button", { name: /分析并生成计划/ }));

    await waitFor(() => expect(onStartRun).toHaveBeenCalledTimes(1));
    const [root, prompt, displayText, options] = onStartRun.mock.calls[0];
    expect(root).toBe("/repo");
    expect(displayText).toBe("实现取消订单并退款");
    expect(prompt).toContain("尽量使用小范围 apply_patch");
    expect(prompt).toContain("库存必须释放");
    expect(prompt).toContain("AGENTS.md");
    expect(options).toEqual({ mode: "plan", modelId: "model-a" });
  });

  it("Ask 中输入明确开发需求时自动使用 Craft 落盘", async () => {
    const user = userEvent.setup();
    const onStartRun = vi.fn().mockResolvedValue("session-craft-auto");
    render(
      <CodingWorkspacePage
        cwd="/repo"
        apiReady
        models={[{ id: "minimax", label: "MiniMax" }]}
        defaultModelId="minimax"
        onStartRun={onStartRun}
        onToast={vi.fn()}
      />,
    );

    await screen.findByText("commerce");
    await user.click(screen.getByRole("radio", { name: /Ask/ }));
    await user.type(screen.getByLabelText("开发需求"), "帮我写一个99乘法表");
    expect(screen.getByText(/Craft 模式真正写入/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "开始快速开发" }));

    await waitFor(() => expect(onStartRun).toHaveBeenCalledTimes(1));
    expect(onStartRun.mock.calls[0][3]).toEqual({ mode: "craft", modelId: "minimax" });
    expect(onStartRun.mock.calls[0][1]).toContain("不得只在聊天中返回示例代码");
  });

  it("进入工作台后主动恢复上次代码开发会话", async () => {
    const onResumeRun = vi.fn().mockResolvedValue(false);
    localStorage.setItem(`echo-coding-workspace:${encodeURIComponent("/repo")}`, JSON.stringify({
      version: 2,
      root: "/repo",
      requirement: "继续未完成的开发",
      acceptanceCriteria: [],
      validationRecords: [],
      docLevels: [],
      mode: "craft",
      contextPaths: [],
      reviewedFiles: [],
      sessionId: "persisted-coding-session",
    }));

    render(<CodingWorkspacePage cwd="/repo" onResumeRun={onResumeRun} />);

    await waitFor(() => expect(onResumeRun).toHaveBeenCalledWith("persisted-coding-session", "/repo"));
    expect(screen.getAllByRole("button", { name: "新建开发任务" }).length).toBeGreaterThan(0);
  });

  it("将 Runtime 待回答问题显示在代码工作台，不再假装持续分析", async () => {
    const sessionId = "session-awaiting-question";
    const question: QuestionRequest = {
      requestId: "question-1",
      sessionId,
      toolCallId: "ask-1",
      title: "确认 Hello World 实现方式",
      mode: "plan",
      questions: [{
        id: "language",
        question: "使用哪种语言？",
        multiSelect: false,
        options: [
          { label: "Python", description: "直接运行脚本" },
          { label: "JavaScript", description: "使用 Node.js 运行" },
        ],
      }],
    };
    localStorage.setItem(`echo-coding-workspace:${encodeURIComponent("/repo")}`, JSON.stringify({
      version: 2,
      root: "/repo",
      requirement: "帮我实现一个 Hello World 程序",
      acceptanceCriteria: [],
      validationRecords: [],
      docLevels: [],
      mode: "plan",
      contextPaths: [],
      reviewedFiles: [],
      sessionId,
      startedAt: "2020-01-01T00:00:00.000Z",
    }));
    useSessionsStore.setState({ currentSessionId: sessionId });
    const store = useSessionStore.getState();
    store.setSession(sessionId);
    store.pushUser("帮我实现一个 Hello World 程序", [], sessionId);
    store.startStreaming(sessionId, "prompt-question");
    useQuestionStore.getState().request(question);
    mocks.listPendingInteractions.mockResolvedValue({
      permissions: [],
      questions: [question],
      planApprovals: [],
      folderTrustRequests: [],
    });

    render(<CodingWorkspacePage cwd="/repo" apiReady onToast={vi.fn()} />);

    expect((await screen.findAllByText("等待你的回答")).length).toBeGreaterThan(0);
    expect(screen.getByText("使用哪种语言？")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Python/ })).toBeInTheDocument();
    expect(screen.queryByText("正在分析代码库")).not.toBeInTheDocument();
    expect(document.querySelector(".coding-run-status time")).toBeNull();
  });

  it("将文件和命令授权请求显示在代码工作台", async () => {
    const sessionId = "session-awaiting-permission";
    localStorage.setItem(`echo-coding-workspace:${encodeURIComponent("/repo")}`, JSON.stringify({
      version: 2,
      root: "/repo",
      requirement: "创建 hello.py",
      acceptanceCriteria: [],
      validationRecords: [],
      docLevels: [],
      mode: "craft",
      contextPaths: [],
      reviewedFiles: [],
      sessionId,
    }));
    useSessionsStore.setState({ currentSessionId: sessionId });
    const store = useSessionStore.getState();
    store.setSession(sessionId);
    store.pushUser("创建 hello.py", [], sessionId);
    store.startStreaming(sessionId, "prompt-permission");
    usePermissionStore.getState().request({
      requestId: "permission-1",
      sessionId,
      toolCallId: "edit-1",
      toolKind: "edit",
      title: "创建 hello.py",
      rawInput: { path: "hello.py" },
      options: [
        { optionId: "allow", kind: "allow", title: "允许本次" },
        { optionId: "deny", kind: "deny", title: "拒绝" },
      ],
    });

    render(<CodingWorkspacePage cwd="/repo" apiReady onToast={vi.fn()} />);

    expect((await screen.findAllByText("等待操作授权")).length).toBeGreaterThan(0);
    expect(screen.getByText("EchoAgent 想要执行以下操作，是否允许？")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "允许本次" })).toBeInTheDocument();
  });

  it("在当前工作区目录中新建文件并立即打开", async () => {
    const user = userEvent.setup();
    render(<CodingWorkspacePage cwd="/repo" apiReady onToast={vi.fn()} />);
    await screen.findByText("commerce");
    await user.click(screen.getByRole("button", { name: "新建文件" }));
    await user.type(screen.getByRole("textbox", { name: "新文件名" }), "new-feature.ts");
    await user.click(screen.getByRole("button", { name: "确认创建" }));

    await waitFor(() => expect(mocks.createEntry).toHaveBeenCalledWith(
      "/repo",
      "/repo",
      "new-feature.ts",
      false,
    ));
    await waitFor(() => expect(mocks.readDocument).toHaveBeenCalledWith("/repo", "/repo/new-feature.ts"));
  });

  it("模型连续返回空工具参数时自动停止并告知具体原因", async () => {
    const sessionId = "session-broken-tools";
    localStorage.setItem(`echo-coding-workspace:${encodeURIComponent("/repo")}`, JSON.stringify({
      version: 2,
      root: "/repo",
      requirement: "完成开发需求",
      acceptanceCriteria: [],
      validationRecords: [],
      docLevels: [],
      mode: "plan",
      contextPaths: [],
      reviewedFiles: [],
      sessionId,
      modelId: "broken-model",
    }));
    useSessionsStore.setState({ currentSessionId: sessionId });
    const store = useSessionStore.getState();
    store.setSession(sessionId);
    store.startStreaming(sessionId, "prompt-1");
    [1, 2, 3].forEach((index) => store.applyUpdate({
      type: "tool_call",
      toolCallId: `tool-${index}`,
      title: "read_file",
      kind: "read_file",
      status: "failed",
      content: [{ type: "text", text: "Tool call has invalid JSON arguments: missing field target_file" }],
      __sessionId: sessionId,
    }));
    const onCancel = vi.fn();

    render(<CodingWorkspacePage cwd="/repo" apiReady onCancel={onCancel} onToast={vi.fn()} />);

    expect((await screen.findAllByText("模型工具协议异常")).length).toBeGreaterThan(0);
    expect(screen.getByText(/当前模型无法完成代码工具调用/)).toBeInTheDocument();
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
  });

  it("异常工具历史后的开发请求使用新 Craft 会话，不继续污染会话", async () => {
    const user = userEvent.setup();
    const sessionId = "session-polluted";
    localStorage.setItem(`echo-coding-workspace:${encodeURIComponent("/repo")}`, JSON.stringify({
      version: 2,
      root: "/repo",
      requirement: "查看代码",
      acceptanceCriteria: [],
      validationRecords: [],
      docLevels: [],
      mode: "ask",
      contextPaths: [],
      reviewedFiles: [],
      sessionId,
      modelId: "minimax",
    }));
    useSessionsStore.setState({
      currentSessionId: sessionId,
      independent: [{ sessionId, cwd: "/repo", title: "旧开发任务", currentModelId: "minimax" }],
    });
    const store = useSessionStore.getState();
    store.setSession(sessionId);
    store.setMessages([{
      id: "old-assistant",
      role: "assistant",
      complete: true,
      parts: [1, 2, 3].map((index) => ({
        kind: "tool_call" as const,
        toolCall: {
          toolCallId: `old-tool-${index}`,
          title: "read_file",
          kind: "read_file",
          status: "failed" as const,
          content: [{ type: "text" as const, text: "missing field target_file" }],
        },
      })),
    }]);
    const onStartRun = vi.fn().mockResolvedValue("session-clean");
    const onSend = vi.fn();

    render(
      <CodingWorkspacePage
        cwd="/repo"
        apiReady
        models={[{ id: "minimax", label: "MiniMax" }]}
        defaultModelId="minimax"
        onStartRun={onStartRun}
        onSend={onSend}
        onToast={vi.fn()}
      />,
    );

    await user.type(await screen.findByLabelText("给 Coding Agent 的补充要求"), "帮我写一个99乘法表");
    await user.click(screen.getByRole("button", { name: "发送给 Coding Agent" }));

    await waitFor(() => expect(onStartRun).toHaveBeenCalledTimes(1));
    expect(onStartRun.mock.calls[0][3]).toEqual({ mode: "craft", modelId: "minimax" });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("回放旧模型的协议错误时不误发 Runtime 停止", async () => {
    const onCancel = vi.fn();
    localStorage.setItem(`echo-coding-workspace:${encodeURIComponent("/repo")}`, JSON.stringify({
      version: 2,
      root: "/repo",
      requirement: "修复代码",
      acceptanceCriteria: [],
      validationRecords: [],
      docLevels: [],
      mode: "craft",
      contextPaths: [],
      reviewedFiles: [],
      sessionId: "persisted-coding-session",
    }));
    useSessionsStore.setState({ currentSessionId: "persisted-coding-session" });
    useSessionStore.getState().setSession("persisted-coding-session");
    useSessionStore.getState().applyUpdate({
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "修复代码" },
      _meta: { promptIndex: 0, isReplay: true },
      __sessionId: "persisted-coding-session",
    } as never);
    for (let index = 0; index < 3; index += 1) {
      useSessionStore.getState().applyUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "broken-" + index,
        title: "Tool input validation failed",
        kind: "other",
        status: "failed",
        content: [{ type: "text", text: "missing field path" }],
        _meta: { promptIndex: 0, isReplay: true },
        __sessionId: "persisted-coding-session",
      } as never);
    }

    render(<CodingWorkspacePage cwd="/repo" apiReady onCancel={onCancel} onToast={vi.fn()} />);

    expect((await screen.findAllByText("模型工具协议异常")).length).toBeGreaterThan(0);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("执行识别到的真实测试命令并记入验证中心", async () => {
    render(<CodingWorkspacePage cwd="/repo" apiReady onToast={vi.fn()} />);
    expect(await screen.findByText("pnpm test")).toBeInTheDocument();

    const preset = screen.getByText("pnpm test").closest("button");
    expect(preset).not.toBeNull();
    fireEvent.click(preset!);
    await waitFor(() => expect(mocks.runCommand).toHaveBeenCalledWith("/repo", "pnpm test", expect.stringMatching(/^coding-/)));

    fireEvent.click(screen.getByRole("tab", { name: /测试/ }));
    expect(await screen.findByText("128 tests passed")).toBeInTheDocument();
    expect(screen.getByText(/退出码 0/)).toBeInTheDocument();
  });

  it("使用带版本指纹的代码编辑器保存，避免覆盖外部改动", async () => {
    const user = userEvent.setup();
    render(<CodingWorkspacePage cwd="/repo" apiReady onToast={vi.fn()} />);
    await user.click(await screen.findByTestId("file-tree"));
    const editor = await screen.findByRole("textbox", { name: "mock code editor" });
    await user.clear(editor);
    await user.type(editor, "export const answer = 42;\n");
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(mocks.writeDocument).toHaveBeenCalledWith(
      "/repo",
      "/repo/src/app.ts",
      "export const answer = 42;\n",
      "hash-before",
    ));
  });

  it("存在未保存代码时阻止误退出或误切换工作区", async () => {
    const user = userEvent.setup();
    const onExit = vi.fn();
    const onSelectWorkspace = vi.fn();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(
      <CodingWorkspacePage
        cwd="/repo"
        apiReady
        onExit={onExit}
        onSelectWorkspace={onSelectWorkspace}
        workspaces={[
          { cwd: "/repo", sessionCount: 1 },
          { cwd: "/other", sessionCount: 1 },
        ]}
      />,
    );
    await user.click(await screen.findByTestId("file-tree"));
    const editor = await screen.findByRole("textbox", { name: "mock code editor" });
    await user.clear(editor);
    await user.type(editor, "const unsaved = true;\n");

    await user.click(screen.getByRole("button", { name: "返回 EchoAgent" }));
    expect(onExit).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /repo/ }));
    await user.click(screen.getByRole("menuitemradio", { name: /other/ }));
    expect(onSelectWorkspace).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: /repo/ }));
    await user.click(screen.getByRole("menuitemradio", { name: /other/ }));
    expect(onSelectWorkspace).toHaveBeenCalledWith("/other");
    confirm.mockRestore();
  });

  it("切换验证视图或收起面板时保留交互式终端会话", async () => {
    const user = userEvent.setup();
    render(<CodingWorkspacePage cwd="/repo" apiReady onToast={vi.fn()} />);
    await screen.findByText("commerce");
    await user.click(screen.getByRole("tab", { name: "终端" }));
    const terminal = screen.getByTestId("coding-terminal");
    expect(terminal).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "验证命令" }));
    expect(terminal).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "收起底部面板" }));
    expect(terminal).toBeInTheDocument();
  });
});
