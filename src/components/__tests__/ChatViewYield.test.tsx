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
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

// session-store mock:可控的 streaming / sessionId / messages。
let storeState: {
  messages: unknown[];
  streaming: boolean;
  streamingMessageId: string | null;
  error: string | null;
  plan: null;
  sessionId: string | null;
  control?: {
    action: "pause" | "stop";
    phase: "pausing" | "paused" | "stopping" | "stopped";
    requestedAt: number;
  };
  resumeSession: (sessionId: string) => void;
} = {
  messages: [],
  streaming: false,
  streamingMessageId: null,
  error: null,
  plan: null,
  sessionId: "s1",
  control: undefined,
  resumeSession: () => {
    storeState = { ...storeState, control: undefined };
  },
};
vi.mock("@/stores/session-store", () => ({
  useSessionStore: (sel: (s: typeof storeState) => unknown) => sel(storeState),
}));
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
    "commandsList", "promptHistory", "tasksList", "taskKill", "permissionList",
    "permissionSave", "permissionModeGet", "permissionModeSet", "memoryList",
    "memoryGet", "memorySave", "memoryAppend", "memoryDelete", "memoryClearSessionSummaries", "memoryRewrite", "memoryFlush", "memoryDream",
    "memoryConfigGet", "memoryConfigSave",
    "sessionSearch", "sessionFork", "agentsList", "agentsGet", "agentsSave",
    "agentsDelete", "agentsTemplate", "mcpList", "mcpUpsert", "mcpDelete",
    "mcpToggle", "mcpConfigPath", "mcpConfigRead", "mcpConfigSave", "mcpAuthTrigger",
    "mcpAuthStatus", "togglePlanMode", "internalReload", "automationsSnapshot",
    "automationsSave", "automationsDelete", "automationsSetStatus", "automationsRun",
    "automationRecordsArchive", "automationRecordsDelete",
    "agentsDefaultsGet", "agentsDefaultsSave",
    "pluginsList", "pluginsAction", "marketplaceList", "marketplaceAction",
    "notificationList", "notificationMarkRead", "notificationMarkAllRead",
    "notificationClear", "exportTextFile", "openUrl", "folderTrustRespond",
    "agentDeleteSession", "agentSetSessionPinned", "agentSetSessionArchived",
    "agentSessionInfo", "agentSessionUsage", "agentResolvePermission",
    "agentResolveQuestion", "connectorsCliStatus", "connectorsCliAuth",
    "connectorsCliAuthCancel", "connectorsCliUnauth", "connectorsCliSkillsDir",
    "onConnectorCliAuthUrl", "onConnectorCliAuthLog", "onConnectorCliAuthDone",
    "connectorsDefaultRoot", "connectorsListRoots", "connectorsLoad", "connectorsIcon",
    "connectorsReadMcpConfig", "skillsCatalogDefaultRoot", "skillsCatalogListRoots",
    "skillsCatalogLoad", "skillsCatalogReadSkill", "expertsDefaultRoot",
    "expertsListRoots", "expertsLoad", "expertsThumbnail", "expertsImageBytes",
    "expertsReadAgentPrompt", "expertsLinkAgents", "agentClearSessionExpert",
    "skillsList", "skillsAdd", "skillsRemove", "skillsToggle",
  ]) {
    mod[name] = name.startsWith("on") ? handler : asyncArr;
  }
  // 个别需要特定返回。
  mod.rewindExecute = vi.fn(asyncEmpty);
  mod.rewindPoints = vi.fn(asyncArr);
  mod.providersList = async () => ({ providers: [], models: [] });
  mod.flattenModels = () => [];
  mod.agentAuthStatus = async () => ({ ready: true, providers: [] });
  mod.subscribeAgentEvents = async () => () => {};
  mod.permissionModeGet = async () => "ask";
  mod.notificationList = asyncArr;
  mod.agentsList = asyncArr;
  mod.mcpList = asyncArr;
  mod.tasksList = asyncArr;
  mod.commandsList = asyncArr;
  mod.promptHistory = asyncArr;
  return mod;
});

import { ChatView } from "../ChatView";
import { ThemeProvider } from "../ThemeProvider";
import { rewindPoints } from "@/lib/agent-client";

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
  onCancel: vi.fn(),
  modelId: "m1",
  onToast: vi.fn(),
};

function setStore(patch: Partial<typeof storeState>) {
  storeState = { ...storeState, ...patch };
}

describe("ChatView pause/yield/resume 闭环", () => {
  beforeEach(() => {
    setStore({
      messages: [{ id: "u1", role: "user", complete: true, parts: [{ kind: "text", text: "hi" }] }],
      streaming: false,
      streamingMessageId: null,
      error: null,
      plan: null,
      sessionId: "s1",
      control: undefined,
    });
    baseProps.onSend.mockClear();
    baseProps.onCancel.mockClear();
    baseProps.onToast.mockClear();
    vi.mocked(rewindPoints).mockReset().mockResolvedValue([]);
  });

  it("会话工具入口统一位于响应式工具栏内", () => {
    const { container } = renderChat();
    const toolbar = container.querySelector(".chatview__utility-actions");
    expect(toolbar).not.toBeNull();
    for (const label of ["查找", "变更", "子代理", "团队", "浏览器", "分享"]) {
      expect(toolbar).toContainElement(screen.getByRole("button", { name: label }));
    }
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

  it("模型初始化失败且没有回溯点时，安全重发原始消息", async () => {
    setStore({
      messages: [
        { id: "u1", role: "user", complete: true, parts: [{ kind: "text", text: "生成每日报告" }] },
        { id: "a1", role: "assistant", complete: true, parts: [] },
      ],
      error: "未选择模型，请选择模型",
    });
    renderChat();

    fireEvent.click(screen.getByRole("button", { name: "重新执行" }));

    await waitFor(() => expect(baseProps.onSend).toHaveBeenCalledWith("生成每日报告", []));
    expect(baseProps.onToast).toHaveBeenCalledWith("已使用当前模型重新发送");
  });

  it("没有回溯点但已产生回复时，不会冒险重复执行", async () => {
    setStore({
      messages: [
        { id: "u1", role: "user", complete: true, parts: [{ kind: "text", text: "执行任务" }] },
        { id: "a1", role: "assistant", complete: true, parts: [{ kind: "text", text: "已执行一部分" }] },
      ],
    });
    renderChat();

    fireEvent.click(screen.getByRole("button", { name: "重新生成" }));

    await waitFor(() => expect(rewindPoints).toHaveBeenCalledWith("s1"));
    expect(baseProps.onSend).not.toHaveBeenCalled();
    expect(baseProps.onToast).toHaveBeenCalledWith("该轮没有可回溯点，为避免重复执行工具无法自动重试。");
  });
});
