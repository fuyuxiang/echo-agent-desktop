/**
 * ChatView pause/yield/resume 闭环集成测试。
 *
 * 验证:
 *  - 流式时显示「暂停」按钮并发送明确的 pause 动作。
 *  - 会话级 control 显示「已暂停」横幅 + 「恢复」/「恢复并继续」两按钮。
 *  - 「恢复」:仅清状态(不触发 onSend)。
 *  - 「恢复并继续」:清状态 + onSend("请继续。")。
 *
 * mock session-store 提供 streaming/sessionId/messages;mock agent-client 的 rewind*。
 */
import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import type { Plan } from "@/lib/types";

const artifactMocks = vi.hoisted(() => ({ load: vi.fn(async () => [] as import("@/lib/session-artifacts").SessionArtifact[]) }));
vi.mock("@/lib/artifact-catalog", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/artifact-catalog")>(),
  loadSessionDocumentArtifacts: artifactMocks.load,
}));

// session-store mock:可控的 streaming / sessionId / messages。
let storeState: {
  messages: unknown[];
  streaming: boolean;
  streamingMessageId: string | null;
  error: string | null;
  plan: Plan | null;
  planRevisionDirty?: boolean;
  transcripts?: Record<string, { planRevisionDirty: boolean }>;
  sessionId: string | null;
  agentMode: "default" | "browser_use" | "computer_use";
  control?: {
    action: "pause" | "stop";
    phase: "pausing" | "paused" | "stopping" | "stopped";
    requestedAt: number;
  };
  resumeSession: (sessionId: string) => void;
  setAgentMode: (mode: "default" | "browser_use" | "computer_use") => void;
  discardMessagesFrom: ReturnType<typeof vi.fn>;
} = {
  messages: [],
  streaming: false,
  streamingMessageId: null,
  error: null,
  plan: null,
  sessionId: "s1",
  agentMode: "default",
  control: undefined,
  resumeSession: () => {
    storeState = { ...storeState, control: undefined };
  },
  setAgentMode: (agentMode) => {
    storeState = { ...storeState, agentMode };
  },
  discardMessagesFrom: vi.fn(),
};
vi.mock("@/stores/session-store", () => {
  const useSessionStore = Object.assign(
    (sel: (s: typeof storeState) => unknown) => sel(storeState),
    { getState: () => storeState },
  );
  return { useSessionStore };
});
vi.mock("@/stores/sessions-store", () => {
  const value = {
    drafts: {} as Record<string, string>,
    setDraft: () => {},
    independent: [] as unknown[],
    upsert: vi.fn(),
  };
  const useSessionsStore = Object.assign(
    (sel: (s: typeof value) => unknown) => sel(value),
    { getState: () => value },
  );
  return { useSessionsStore, HOME_DRAFT_KEY: "home" };
});
vi.mock("@/lib/agent-client", async () => {
  // 用空实现铺满所有被引用的导出,避免「No export defined」。
  const mod: Record<string, unknown> = {};
  const handler = () => undefined;
  const asyncEmpty = async () => undefined;
  const asyncArr = async () => [];
  for (const name of [
    "rewindExecute", "rewindPoints", "agentInit", "agentNewSession", "agentSend",
    "agentCancel", "agentLoadSession", "agentListAllSessions", "agentListSessions", "agentListWorkspaces",
    "agentRenameSession", "agentSetModel", "agentSetSessionExpert", "agentAuthStatus",
    "providersList", "flattenModels", "notificationAppend", "subscribeAgentEvents",
    "commandsList", "promptHistory", "tasksList", "taskKill", "teamSnapshot", "permissionList",
    "permissionSave", "permissionModeGet", "permissionModeSet", "memoryList",
    "memoryGet", "memorySave", "memoryAppend", "memoryDelete", "memoryClearSessionSummaries", "memoryRewrite", "memoryFlush", "memoryDream",
    "memoryConfigGet", "memoryConfigSave",
    "sessionSearch", "sessionFork", "agentsList", "agentsGet", "agentsSave",
    "agentsDelete", "agentsTemplate", "mcpList", "mcpUpsert", "mcpDelete",
    "mcpToggle", "mcpConfigPath", "mcpConfigRead", "mcpConfigSave", "mcpAuthTrigger",
    "mcpAuthStatus", "togglePlanMode", "setCodingMode", "internalReload", "automationsSnapshot",
    "automationsSave", "automationsDelete", "automationsSetStatus", "automationsRun",
    "automationRecordsArchive", "automationRecordsDelete",
    "agentsDefaultsGet", "agentsDefaultsSave",
    "pluginsList", "pluginsAction", "notificationList", "notificationMarkRead", "notificationMarkAllRead",
    "notificationClear", "exportTextFile", "openUrl", "folderTrustRespond",
    "agentDeleteSession", "agentSetSessionPinned", "agentSetSessionArchived",
    "agentSessionInfo", "agentSessionUsage", "agentResolvePermission",
    "agentResolveQuestion", "agentClearSessionExpert", "expertAvatar",
    "skillsList", "skillsAdd", "skillsRemove", "skillsToggle",
  ]) {
    mod[name] = name.startsWith("on") ? handler : asyncArr;
  }
  // 个别需要特定返回。
  mod.rewindExecute = vi.fn(asyncEmpty);
  mod.rewindPoints = vi.fn(asyncArr);
  mod.setCodingMode = vi.fn(asyncEmpty);
  mod.providersList = async () => ({ providers: [], models: [] });
  mod.flattenModels = () => [];
  mod.agentAuthStatus = async () => ({ ready: true, providers: [] });
  mod.subscribeAgentEvents = async () => () => {};
  mod.onTeamsChanged = async () => () => {};
  mod.permissionModeGet = async () => "ask";
  mod.notificationList = asyncArr;
  mod.agentsList = asyncArr;
  mod.mcpList = asyncArr;
  mod.tasksList = asyncArr;
  mod.commandsList = vi.fn(asyncArr);
  mod.promptHistory = asyncArr;
  return mod;
});

import { ChatView } from "../ChatView";
import { ThemeProvider } from "../ThemeProvider";
import { rewindExecute, rewindPoints, setCodingMode, commandsList } from "@/lib/agent-client";
import { useSubagentStore } from "@/stores/subagent-store";

/** 用 ThemeProvider 包裹(ChatView 内的 MessageItem/Markdown 需要 useTheme)。 */
function renderChat() {
  return render(
    <ThemeProvider>
      <ChatView {...baseProps} />
    </ThemeProvider>,
  );
}

const baseProps = {
  onSend: vi.fn(),
  onPrepareRetry: vi.fn(async () => true),
  onRetrySend: vi.fn(() => true),
  onCancel: vi.fn(),
  modelId: "m1",
  onToast: vi.fn(),
};

const scrollIntoViewMock = vi.fn();

function setStore(patch: Partial<typeof storeState>) {
  storeState = { ...storeState, ...patch };
}

describe("ChatView pause/yield/resume 闭环", () => {
  beforeEach(() => {
    artifactMocks.load.mockReset().mockResolvedValue([]);
    useSubagentStore.setState({ bySession: {} });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoViewMock,
    });
    setStore({
      messages: [{ id: "u1", role: "user", complete: true, parts: [{ kind: "text", text: "hi" }] }],
      streaming: false,
      streamingMessageId: null,
      error: null,
      plan: null,
      planRevisionDirty: false,
      transcripts: {},
      sessionId: "s1",
      agentMode: "default",
      control: undefined,
    });
    baseProps.onSend.mockClear();
    baseProps.onPrepareRetry.mockClear().mockResolvedValue(true);
    baseProps.onRetrySend.mockClear().mockReturnValue(true);
    baseProps.onCancel.mockClear();
    baseProps.onToast.mockClear();
    storeState.discardMessagesFrom.mockClear();
    scrollIntoViewMock.mockClear();
    vi.mocked(rewindExecute).mockReset().mockResolvedValue({ targetPromptIndex: 0 });
    vi.mocked(rewindPoints).mockReset().mockResolvedValue([]);
    vi.mocked(setCodingMode).mockClear();
  });

  it("已打开计划清空后仍保留真实编辑器和新增草稿，收起后可重开", () => {
    setStore({ plan: { entries: [{ content: "最后一步", priority: "medium", status: "pending" }] }, transcripts: { s1: { planRevisionDirty: false } } });
    const { rerender } = renderChat();
    fireEvent.click(screen.getByRole("button", { name: "计划 0/1" }));
    fireEvent.change(screen.getByRole("textbox", { name: "新增步骤" }), { target: { value: "保留待确认的新增草稿" } });
    setStore({ plan: { entries: [] }, planRevisionDirty: true, transcripts: { s1: { planRevisionDirty: true } } });
    rerender(<ThemeProvider><ChatView {...baseProps} /></ThemeProvider>);
    expect(screen.getByRole("textbox", { name: "新增步骤" })).toHaveValue("保留待确认的新增草稿");
    fireEvent.click(screen.getByRole("button", { name: "计划 0/0" }));
    expect(screen.queryByRole("textbox", { name: "新增步骤" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "计划 0/0" }));
    expect(screen.getByRole("textbox", { name: "新增步骤" })).toBeInTheDocument();
  });

  it("CORE19 真实 ACP flat plan 经生产 store 后显示可打开的计划入口", async () => {
    const actual = await vi.importActual<typeof import("@/stores/session-store")>("@/stores/session-store");
    actual.useSessionStore.setState({ sessionId: null, transcripts: {}, plan: null });
    const productionStore = actual.useSessionStore.getState();
    productionStore.setSession("s1");
    productionStore.applyUpdate({
      sessionUpdate: "plan",
      entries: [
        { content: "批准后保存实际成果", priority: "medium", status: "pending" },
        { content: "核对成果内容", priority: "high", status: "pending" },
      ],
      __sessionId: "s1",
    } as never);
    setStore({ plan: actual.useSessionStore.getState().plan });
    renderChat();
    fireEvent.click(screen.getByRole("button", { name: "计划 0/2" }));
    expect(screen.getByText("批准后保存实际成果")).toBeInTheDocument();
    expect(screen.getByText("核对成果内容")).toBeInTheDocument();
  });

  afterEach(() => {
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it("会话工具入口统一位于响应式工具栏内", () => {
    const { container } = renderChat();
    const toolbar = container.querySelector(".chatview__utility-actions");
    expect(toolbar).not.toBeNull();
    for (const label of ["查找", "变更", "子代理", "团队", "浏览器", "分享"]) {
      expect(toolbar).toContainElement(screen.getByRole("button", { name: label }));
    }
  });

  it.each(["变更", "团队"])("跨会话关闭%s面板不会恢复旧会话的位置或停止跟随", (label) => {
    const { container, rerender } = renderChat();
    const viewport = container.querySelector<HTMLElement>(".chatview__scroll")!;
    Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: 2000 });
    Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 400 });
    // User reads an older message in session A before opening the panel.
    viewport.scrollTop = 600;
    fireEvent.wheel(viewport, { deltaY: -1 });
    fireEvent.scroll(viewport);
    fireEvent.click(screen.getByRole("button", { name: label }));
    setStore({ sessionId: "s2", messages: [...storeState.messages] });
    rerender(<ThemeProvider><ChatView {...baseProps} /></ThemeProvider>);
    expect(viewport.scrollTop).toBe(1600);
    fireEvent.click(screen.getByRole("button", { name: label }));
    fireEvent.scroll(viewport);
    expect(viewport.scrollTop).toBe(1600);
    expect(screen.queryByRole("button", { name: "回到最新消息并恢复自动跟随" })).toBeNull();
    Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: 2200 });
    setStore({ messages: [...storeState.messages], streaming: true });
    rerender(<ThemeProvider><ChatView {...baseProps} /></ThemeProvider>);
    expect(viewport.scrollTop).toBe(1800);
  });

  it("在同一会话关闭面板会恢复历史阅读位置", () => {
    const { container } = renderChat();
    const viewport = container.querySelector<HTMLElement>(".chatview__scroll")!;
    Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: 2000 });
    Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 400 });
    viewport.scrollTop = 600;
    fireEvent.wheel(viewport, { deltaY: -1 });
    fireEvent.scroll(viewport);
    fireEvent.click(screen.getByRole("button", { name: "变更" }));
    viewport.scrollTop = 0;
    fireEvent.scroll(viewport);
    fireEvent.click(screen.getByRole("button", { name: "变更" }));
    expect(viewport.scrollTop).toBe(600);
    expect(screen.getByRole("button", { name: "回到最新消息并恢复自动跟随" })).toBeInTheDocument();
  });

  it("从子代理返回后恢复展开条目和原阅读位置", async () => {
    useSubagentStore.getState().applyEvent({ sessionId: "s1", phase: "finished", subagentId: "child",
      childSessionId: "child", description: "核验任务", status: "completed" });
    let rowTop = 150;
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("chatview__scroll")) return { top: 50 } as DOMRect;
      if (this.classList.contains("subagent-panel__row")) return { top: rowTop } as DOMRect;
      return originalRect.call(this);
    });
    try {
      const openChild = vi.fn();
      const props = { ...baseProps, cwd: "/workspace", onOpenSubagentSession: openChild };
      const { container, rerender } = render(<ThemeProvider><ChatView {...props} /></ThemeProvider>);
      const viewport = container.querySelector<HTMLElement>(".chatview__scroll")!;
      Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: 1000 });
      Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 400 });
      fireEvent.click(screen.getByRole("button", { name: "子代理" }));
      fireEvent.click(screen.getByRole("button", { name: /核验任务/ }));
      viewport.scrollTop = 350;
      fireEvent.click(screen.getByRole("button", { name: "打开完整工作记录" }));
      expect(openChild).toHaveBeenCalledWith("child", "/workspace", {
        parentSessionId: "s1", parentCwd: "/workspace", subagentKey: "child", scrollTop: 350, rowOffset: 100,
      });

      setStore({ sessionId: "child" });
      rerender(<ThemeProvider><ChatView {...props} /></ThemeProvider>);
      rowTop = 250;
      setStore({ sessionId: "s1" });
      const restorePoint = { parentSessionId: "s1", parentCwd: "/workspace", childSessionId: "child",
        subagentKey: "child", scrollTop: 350, rowOffset: 100, sequence: 1 };
      rerender(<ThemeProvider><ChatView {...props} subagentScrollRestore={restorePoint} /></ThemeProvider>);
      await waitFor(() => expect(screen.getByRole("button", { name: /核验任务/ })).toHaveAttribute("aria-expanded", "true"));
      await waitFor(() => expect(viewport.scrollTop).toBe(450));
    } finally {
      rectSpy.mockRestore();
    }
  });

  it("已有任务也从输入框 + 菜单开启网页操作", async () => {
    renderChat();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "添加" }));
    });
    fireEvent.click(screen.getByRole("menuitemradio", { name: /操作网页/ }));

    await waitFor(() => expect(setCodingMode).toHaveBeenCalledWith("s1", "browser_use"));
    expect(baseProps.onToast).toHaveBeenCalledWith("已启用操作网页");
  });

  it("查询变化后首个真实命中立即定位，后续导航平滑滚动", async () => {
    setStore({
      messages: [{
        id: "a-find",
        role: "assistant",
        complete: true,
        parts: [{ kind: "text", text: "第一只鸟，第二只鸟" }],
      }],
    });
    renderChat();
    fireEvent.click(screen.getByRole("button", { name: "查找" }));
    fireEvent.change(screen.getByRole("textbox", { name: "查找" }), {
      target: { value: "鸟" },
    });

    await waitFor(() => {
      expect(scrollIntoViewMock).toHaveBeenCalledWith({
        behavior: "auto",
        block: "center",
      });
    });
    scrollIntoViewMock.mockClear();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "查找" }), { key: "Enter" });
    await waitFor(() => {
      expect(scrollIntoViewMock).toHaveBeenCalledWith({
        behavior: "smooth",
        block: "center",
      });
    });
  });

  it("从历史提问跳转时暂停自动跟随，并可回到最新消息", async () => {
    setStore({
      messages: [
        { id: "u1", role: "user", complete: true, parts: [{ kind: "text", text: "最初的问题" }] },
        { id: "a1", role: "assistant", complete: true, parts: [{ kind: "text", text: "已回答" }] },
        { id: "u2", role: "user", complete: true, parts: [{ kind: "text", text: "后来的问题" }] },
        { id: "a2", role: "assistant", complete: false, parts: [{ kind: "text", text: "正在回答" }] },
      ],
      streaming: true,
      streamingMessageId: "a2",
    });
    renderChat();

    fireEvent.click(screen.getByRole("button", { name: "历史提问" }));
    const dialog = screen.getByRole("dialog", { name: "历史提问" });
    expect(within(dialog).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "", "2后来的问题", "1最初的问题",
    ]);
    fireEvent.click(within(dialog).getByRole("button", { name: /最初的问题/ }));

    expect(screen.queryByRole("dialog", { name: "历史提问" })).toBeNull();
    expect(scrollIntoViewMock).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
    expect(screen.getByText("最初的问题").closest("[data-msg-id]")).toHaveClass("msg-wrap--jump-target");
    const jumpButton = screen.getByRole("button", { name: "回到最新消息并恢复自动跟随" });
    fireEvent.click(jumpButton);
    await waitFor(() => expect(screen.queryByRole("button", { name: "回到最新消息并恢复自动跟随" })).toBeNull());
  });

  it("切换会话后清空历史提问浮层和旧查询", async () => {
    const { rerender } = renderChat();
    fireEvent.click(screen.getByRole("button", { name: "历史提问" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "筛选历史提问" }), { target: { value: "hi" } });

    setStore({
      sessionId: "s2",
      messages: [{ id: "u-next", role: "user", complete: true, parts: [{ kind: "text", text: "新会话的问题" }] }],
    });
    rerender(<ThemeProvider><ChatView {...baseProps} /></ThemeProvider>);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "历史提问" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "历史提问" }));
    const dialog = screen.getByRole("dialog", { name: "历史提问" });
    expect(within(dialog).getByRole("searchbox", { name: "筛选历史提问" })).toHaveValue("");
    expect(within(dialog).getByRole("button", { name: /新会话的问题/ })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /hi/ })).toBeNull();
  });

  it("流式时显示「暂停」按钮,点击触发 onCancel", () => {
    setStore({ streaming: true, streamingMessageId: "a1" });
    renderChat();
    const pauseBtn = screen.getByTitle("暂停生成(保留会话,可继续)");
    fireEvent.click(pauseBtn);
    expect(baseProps.onCancel).toHaveBeenCalledWith("pause");
  });

  it("流式时复制历史消息会暂停自动跟随，可手动回到最新", async () => {
    setStore({ streaming: true, streamingMessageId: "a1" });
    renderChat();

    fireEvent.pointerDown(screen.getByRole("button", { name: "复制" }));

    const jumpButton = await screen.findByRole("button", {
      name: "回到最新消息并恢复自动跟随",
    });
    fireEvent.click(jumpButton);
    await waitFor(() => {
      expect(screen.queryByRole("button", {
        name: "回到最新消息并恢复自动跟随",
      })).toBeNull();
    });
  });

  it("会话进入 paused 后显示横幅 + 两个恢复按钮", async () => {
    setStore({ streaming: true, streamingMessageId: "a1" });
    const { rerender } = renderChat();
    fireEvent.click(screen.getByTitle("暂停生成(保留会话,可继续)"));
    setStore({
      streaming: false,
      streamingMessageId: null,
      control: { action: "pause", phase: "paused", requestedAt: 1 },
    });
    rerender(
      <ThemeProvider>
        <ChatView {...baseProps} />
      </ThemeProvider>,
    );
    await waitFor(() => expect(screen.getByText("已暂停（会话上下文已保留）")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "恢复" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "恢复并继续" })).toBeInTheDocument();
  });

  it("过渡态禁止重复输入，已停止后允许用新消息继续", () => {
    setStore({
      streaming: false,
      streamingMessageId: null,
      control: { action: "stop", phase: "stopping", requestedAt: 1 },
    });
    const { rerender } = renderChat();
    expect(screen.getByText("正在停止任务…")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toBeDisabled();

    setStore({
      control: { action: "stop", phase: "stopped", requestedAt: 1 },
    });
    rerender(<ThemeProvider><ChatView {...baseProps} /></ThemeProvider>);
    expect(screen.getByText("已停止（发送新消息可继续此任务）")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "继续此任务" })).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toBeEnabled();
  });

  it("取消失败且没有 control 时不会伪装成已暂停", async () => {
    setStore({ streaming: true, streamingMessageId: "a1" });
    baseProps.onCancel.mockResolvedValueOnce(false);
    const { rerender } = renderChat();
    fireEvent.click(screen.getByTitle("暂停生成(保留会话,可继续)"));
    await waitFor(() => expect(baseProps.onCancel).toHaveBeenCalledWith("pause"));
    setStore({ streaming: true, streamingMessageId: "a1", control: undefined });
    rerender(
      <ThemeProvider>
        <ChatView {...baseProps} />
      </ThemeProvider>,
    );
    expect(screen.queryByText("已暂停（会话上下文已保留）")).toBeNull();
  });

  it("「恢复」仅清状态,不触发 onSend", async () => {
    setStore({
      streaming: false,
      streamingMessageId: null,
      control: { action: "pause", phase: "paused", requestedAt: 1 },
    });
    const { rerender } = renderChat();
    await waitFor(() => expect(screen.getByText("已暂停（会话上下文已保留）")).toBeInTheDocument());
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "恢复" }));
    });
    expect(baseProps.onSend).not.toHaveBeenCalled();
    rerender(<ThemeProvider><ChatView {...baseProps} /></ThemeProvider>);
    await waitFor(() =>
      expect(screen.queryByText("已暂停（会话上下文已保留）")).toBeNull(),
    );
  });

  it("「恢复并继续」清状态 + onSend(\"请继续。\")", async () => {
    setStore({
      streaming: false,
      streamingMessageId: null,
      control: { action: "pause", phase: "paused", requestedAt: 1 },
    });
    const { rerender } = renderChat();
    await waitFor(() => expect(screen.getByText("已暂停（会话上下文已保留）")).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "恢复并继续" }));
    });
    expect(baseProps.onSend).toHaveBeenCalledWith("请继续。");
    rerender(<ThemeProvider><ChatView {...baseProps} /></ThemeProvider>);
    await waitFor(() =>
      expect(screen.queryByText("已暂停（会话上下文已保留）")).toBeNull(),
    );
  });

  it("「恢复并继续」未被接纳时保留暂停闸门", async () => {
    setStore({
      streaming: false,
      streamingMessageId: null,
      control: { action: "pause", phase: "paused", requestedAt: 1 },
    });
    baseProps.onSend.mockResolvedValueOnce(false);
    const { rerender } = renderChat();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "恢复并继续" }));
    });

    rerender(<ThemeProvider><ChatView {...baseProps} /></ThemeProvider>);
    expect(screen.getByText("已暂停（会话上下文已保留）")).toBeInTheDocument();
    expect(baseProps.onToast).toHaveBeenCalledWith(expect.stringContaining("任务仍保持暂停"));
  });

  it("请求未进入 Runtime 时，原位清理失败轮次后重试", async () => {
    setStore({
      messages: [
        { id: "u1", role: "user", complete: true, parts: [{ kind: "text", text: "生成每日报告" }] },
        { id: "a1", role: "assistant", complete: true, parts: [] },
      ],
      error: "未选择模型，请选择模型",
    });
    renderChat();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    await waitFor(() => expect(baseProps.onRetrySend).toHaveBeenCalledWith({
      sessionId: "s1",
      displayText: "生成每日报告",
      promptText: "生成每日报告",
      attachments: [],
      kind: "retry",
    }));
    expect(storeState.discardMessagesFrom).toHaveBeenCalledWith("s1", "u1");
    expect(baseProps.onSend).not.toHaveBeenCalled();
  });

  it("无法安全替换纯文本回复时保留原回复，不追加重复消息", async () => {
    setStore({
      messages: [
        { id: "u1", role: "user", complete: true, parts: [{ kind: "text", text: "执行任务" }] },
        { id: "a1", role: "assistant", complete: true, parts: [{ kind: "text", text: "已执行一部分" }] },
      ],
    });
    renderChat();

    fireEvent.click(screen.getByRole("button", { name: "重新生成" }));

    await waitFor(() => expect(rewindPoints).toHaveBeenCalledWith("s1"));
    expect(baseProps.onRetrySend).not.toHaveBeenCalled();
    expect(storeState.discardMessagesFrom).not.toHaveBeenCalled();
    expect(baseProps.onToast).toHaveBeenCalledWith(
      "重新生成失败：暂时无法替换这条回复，原回复已保留。请稍后重试。",
    );
  });

  it("重新生成使用被替换轮次的原始模型提示", async () => {
    setStore({
      messages: [
        {
          id: "u1",
          role: "user",
          complete: true,
          promptIndex: 4,
          agentText: "<hidden>project contract</hidden>\n\n执行任务",
          attachments: ["/tmp/方案.docx"],
          parts: [{ kind: "text", text: "执行任务" }],
        },
        { id: "a1", role: "assistant", complete: true, parts: [{ kind: "text", text: "旧回答" }] },
      ],
    });
    vi.mocked(rewindPoints).mockResolvedValue([
      { promptIndex: 2 },
      { promptIndex: 4 },
      { promptIndex: 3 },
    ]);
    vi.mocked(rewindExecute).mockResolvedValue({
      targetPromptIndex: 4,
      promptText: "<hidden>project contract</hidden>\n\n执行任务"
        + "\n\n附件（图片已作为多模态内容附加；其他文件请使用 read_file 读取）：\n- @/tmp/方案.docx",
    });
    renderChat();

    fireEvent.click(screen.getByRole("button", { name: "重新生成" }));

    await waitFor(() => expect(rewindExecute).toHaveBeenCalledWith("s1", 4, "conversation_only", true));
    expect(baseProps.onRetrySend).toHaveBeenCalledWith({
      sessionId: "s1",
      displayText: "执行任务",
      promptText: "<hidden>project contract</hidden>\n\n执行任务",
      attachments: ["/tmp/方案.docx"],
      kind: "regenerate",
    });
  });

  it("工具轮次必须确认后才会重新执行，且只回溯对话", async () => {
    setStore({
      messages: [
        { id: "u1", role: "user", complete: true, parts: [{ kind: "text", text: "帮我查查 ls" }] },
        {
          id: "a1",
          role: "assistant",
          complete: true,
          parts: [
            {
              kind: "tool_call",
              toolCall: {
                toolCallId: "tool-1",
                title: "运行终端命令",
                kind: "terminal",
                status: "completed",
                content: [],
              },
            },
            { kind: "text", text: "目录已列出。" },
          ],
        },
      ],
    });
    vi.mocked(rewindPoints).mockResolvedValue([{ promptIndex: 0 }]);
    renderChat();

    fireEvent.click(screen.getByRole("button", { name: "重新执行" }));
    const dialog = screen.getByRole("alertdialog", { name: "重新执行本轮任务？" });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText(/1 个工具/)).toBeInTheDocument();
    expect(dialog).toHaveTextContent("将从当前工作区状态开始");
    expect(dialog).not.toHaveTextContent("回溯");
    expect(rewindPoints).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "重新执行" }));
    await waitFor(() => expect(rewindExecute).toHaveBeenCalledWith("s1", 0, "conversation_only", true));
    expect(baseProps.onRetrySend).toHaveBeenCalledWith({
      sessionId: "s1",
      displayText: "帮我查查 ls",
      promptText: "帮我查查 ls",
      attachments: [],
      kind: "reexecute",
    });
  });
});

it("restored native export receipts become reachable after history loading binds the session", async () => {
  storeState = { ...storeState, sessionId: "export-history", messages: [], streaming: false, error: null, plan: null };
  artifactMocks.load.mockReset().mockResolvedValue([{ id: "manual", path: "/synthetic/report.docx", kind: "document_export",
    title: "报告 · DOCX", toolCallId: "document-export:receipt", status: "completed", verifiedOutput: true }]);
  localStorage.clear();
  const { rerender } = render(<ThemeProvider><ChatView {...baseProps} modelLoading /></ThemeProvider>);
  expect(artifactMocks.load).not.toHaveBeenCalled();
  rerender(<ThemeProvider><ChatView {...baseProps} modelLoading={false} /></ThemeProvider>);
  const button = await screen.findByRole("button", { name: /产物 1/ });
  expect(artifactMocks.load).toHaveBeenCalledWith("export-history");
  fireEvent.click(button);
  expect(await screen.findByText("report.docx")).toBeInTheDocument();
});


it("历史任务使用自己的目录发现命令，新建动作不会重绑旧任务", async () => {
  storeState = { ...storeState, sessionId: "session-a", messages: [], streaming: false, error: null, plan: null };
  vi.mocked(commandsList).mockClear();
  vi.mocked(commandsList).mockResolvedValue([{name:"project-a-skill", description:"A 的技能"}]);
  const onNewTask = vi.fn();
  const onSend = vi.fn();
  const {rerender} = render(<ThemeProvider><ChatView {...baseProps} onSend={onSend} cwd="/workspace/A" onNewTask={onNewTask} /></ThemeProvider>);
  expect(screen.getByTitle("本任务工作目录：/workspace/A")).toBeInTheDocument();
  const input = screen.getByRole("textbox");
  fireEvent.change(input, {target:{value:"/project-a"}});
  await waitFor(() => expect(commandsList).toHaveBeenLastCalledWith("session-a", "/workspace/A"));
  fireEvent.click(screen.getByRole("button", {name:"新建任务"}));
  expect(onNewTask).toHaveBeenCalledOnce();
  // A future task may choose C, while this mounted historical task stays A.
  rerender(<ThemeProvider><ChatView {...baseProps} onSend={onSend} cwd="/workspace/A" onNewTask={onNewTask} commandRefreshKey={1} /></ThemeProvider>);
  await waitFor(() => expect(commandsList).toHaveBeenLastCalledWith("session-a", "/workspace/A"));
  expect(screen.queryByRole("button", {name:/工作目录/})).toBeNull();
  expect(await screen.findByText("/project-a-skill")).toBeInTheDocument();
});
