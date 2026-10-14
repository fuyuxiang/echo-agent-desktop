import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/agent-client", () => ({ setCodingMode: vi.fn(async () => {}) }));
vi.mock("@/lib/automation-client", () => ({
  automationClearBrowserData: vi.fn(),
  automationPause: vi.fn(),
  automationPendingApprovals: vi.fn(),
  automationRequestComputerPermissions: vi.fn(),
  automationResolveApproval: vi.fn(async () => true),
  automationResume: vi.fn(),
  automationSetPrivateNetwork: vi.fn(),
  automationStatus: vi.fn(),
  automationStop: vi.fn(),
  onAutomationApproval: vi.fn(async () => () => {}),
  onAutomationApprovalClosed: vi.fn(async () => () => {}),
  onAutomationStatus: vi.fn(async () => () => {}),
}));

import { AutomationControls } from "../AutomationControls";
import * as automationClient from "@/lib/automation-client";
import { useSessionStore } from "@/stores/session-store";

const availableStatus = {
  sessionId: "session-1",
  mode: "browser_use" as const,
  paused: false,
  allowPrivateNetwork: false,
  browser: { available: true, browserName: "Chrome" },
  computer: {
    available: false,
    platform: "Wayland",
    screenCapture: false,
    inputControl: false,
    reason: "Wayland 会话不支持全局控制",
  },
  browserRunning: false,
  browserUrl: null,
  browserTitle: null,
  browserHasData: true,
};

describe("AutomationControls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    useSessionStore.setState({ agentMode: "browser_use" });
    vi.mocked(automationClient.automationStatus).mockResolvedValue(availableStatus);
    vi.mocked(automationClient.automationPendingApprovals).mockResolvedValue([]);
  });

  it("默认任务不渲染 Agent 模式控件", async () => {
    useSessionStore.setState({ agentMode: "default" });
    const { container } = render(
      <AutomationControls
        sessionId="session-1"
        streaming={false}
        placement="toolbar"
      />,
    );
    await act(async () => {});

    expect(container.querySelector(".automation-control")).toBeNull();
    expect(screen.queryByText("Agent")).toBeNull();
  });

  it("只在能力启用后展示紧凑状态，隐私和数据清理收入更多菜单", async () => {
    render(
      <AutomationControls
        sessionId="session-1"
        streaming={false}
        placement="toolbar"
      />,
    );

    await screen.findByText("Chrome 将在需要时自动启动");
    expect(screen.getByText("操作网页")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "任务模式" })).toBeNull();
    expect(screen.queryByText("Browser Use")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "更多自动化选项" }));
    expect(screen.getByText("网页或屏幕内容会发送给当前模型。")).toBeInTheDocument();
    const clearTrigger = screen.getByRole("button", { name: "清除本任务浏览器数据" });
    await act(async () => { fireEvent.click(clearTrigger); });
    expect(await screen.findByText("清除该任务的浏览器数据？")).toBeInTheDocument();
    const clearButtons = screen.getAllByRole("button", { name: "清除数据" });
    await act(async () => { fireEvent.click(clearButtons[clearButtons.length - 1]); });
    await waitFor(() => expect(automationClient.automationClearBrowserData)
      .toHaveBeenCalledWith("session-1"));
  });

  it("确认卡片默认聚焦拒绝，且不展示 URL 查询密钥或输入文本", async () => {
    vi.mocked(automationClient.automationPendingApprovals).mockResolvedValue([{
      requestId: "approval-1",
      sessionId: "session-1",
      tool: "browser_type",
      title: "确认填写",
      description: "请核对网站与目标",
      details: {
        url: "https://example.com/account?token=must-not-render",
        pageTitle: "账户",
        target: { name: "邮箱" },
        characters: 18,
      },
    }]);

    render(
      <AutomationControls
        sessionId="session-1"
        streaming={false}
        placement="approval"
      />,
    );

    const reject = await screen.findByRole("button", { name: "拒绝" });
    await waitFor(() => expect(reject).toHaveFocus());
    expect(screen.getByText("https://example.com/account")).toBeInTheDocument();
    expect(screen.queryByText(/must-not-render/)).toBeNull();
    expect(screen.getByText("18 个字符")).toBeInTheDocument();

    await act(async () => { fireEvent.click(reject); });
    expect(automationClient.automationResolveApproval).toHaveBeenCalledWith("approval-1", false);
  });

  it("切换会话后旧状态查询不会覆盖当前会话", async () => {
    let finishOld!: (value: typeof availableStatus) => void;
    vi.mocked(automationClient.automationStatus).mockImplementation((id) => id === "session-1"
      ? new Promise((resolve) => { finishOld = resolve; })
      : Promise.resolve({ ...availableStatus, sessionId: id, paused: true }));
    const view = render(<AutomationControls sessionId="session-1" streaming={false} placement="toolbar" />);
    await waitFor(() => expect(finishOld).toBeDefined());
    view.rerender(<AutomationControls sessionId="session-2" streaming={false} placement="toolbar" />);
    await screen.findByText("浏览器控制已暂停，你可以安全接管");
    await act(async () => { finishOld(availableStatus); });
    expect(screen.getByText("浏览器控制已暂停，你可以安全接管")).toBeInTheDocument();
  });

  it("较新的状态事件优先于正在返回的旧查询", async () => {
    let finish!: (value: typeof availableStatus) => void;
    vi.mocked(automationClient.automationStatus).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    render(<AutomationControls sessionId="session-1" streaming={false} placement="toolbar" />);
    await waitFor(() => expect(automationClient.automationStatus).toHaveBeenCalled());
    const onStatus = vi.mocked(automationClient.onAutomationStatus).mock.calls[0][0];
    await act(async () => { onStatus({ ...availableStatus, paused: true }); finish(availableStatus); });
    expect(screen.getByText("浏览器控制已暂停，你可以安全接管")).toBeInTheDocument();
  });

  it("已关闭的确认不会由迟到的查询或事件重新打开", async () => {
    const request = { requestId: "closed-1", sessionId: "session-1", tool: "browser_click", title: "已取消操作", description: "不应显示", details: {} };
    let finish!: (value: typeof request[]) => void;
    vi.mocked(automationClient.automationPendingApprovals).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    render(<AutomationControls sessionId="session-1" streaming={false} placement="approval" />);
    await waitFor(() => expect(automationClient.automationPendingApprovals).toHaveBeenCalled());
    const closed = vi.mocked(automationClient.onAutomationApprovalClosed).mock.calls[0][0];
    const opened = vi.mocked(automationClient.onAutomationApproval).mock.calls[0][0];
    await act(async () => { closed({ requestId: request.requestId, sessionId: request.sessionId }); opened(request); finish([request]); });
    expect(screen.queryByText("已取消操作")).toBeNull();
  });

  it("部分监听注册失败时清理已注册监听", async () => {
    const unlisten = vi.fn();
    vi.mocked(automationClient.onAutomationStatus).mockResolvedValueOnce(unlisten);
    vi.mocked(automationClient.onAutomationApproval).mockRejectedValueOnce(new Error("监听失败"));
    const view = render(<AutomationControls sessionId="session-1" streaming={false} placement="toolbar" />);
    await screen.findByText("监听失败");
    view.unmount();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("切换任务后不再提示旧任务的接管结果", async () => {
    let finishPause!: (value: typeof availableStatus) => void;
    vi.mocked(automationClient.automationPause).mockReturnValue(new Promise((resolve) => { finishPause = resolve; }));
    vi.mocked(automationClient.automationStatus).mockImplementation(async (sessionId) => ({ ...availableStatus, sessionId }));
    const onToast = vi.fn();
    const view = render(<AutomationControls sessionId="session-1" streaming={false} placement="toolbar" onToast={onToast} />);
    await screen.findByText("Chrome 将在需要时自动启动");
    fireEvent.click(screen.getByRole("button", { name: "接管" }));
    expect(automationClient.automationPause).toHaveBeenCalledWith("session-1");
    view.rerender(<AutomationControls sessionId="session-2" streaming={false} placement="toolbar" onToast={onToast} />);
    await screen.findByText("Chrome 将在需要时自动启动");
    await act(async () => { finishPause({ ...availableStatus, paused: true }); });
    expect(onToast).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "接管" })).toBeEnabled();
  });

  it("离开旧任务后不提示其确认回复错误", async () => {
    let failResolve!: (error: Error) => void;
    const request = { requestId: "old-approval", sessionId: "session-1", tool: "browser_click", title: "旧任务确认", description: "核对目标", details: {} };
    vi.mocked(automationClient.automationPendingApprovals).mockImplementation(async (sessionId) => sessionId === "session-1" ? [request] : []);
    vi.mocked(automationClient.automationResolveApproval).mockReturnValueOnce(new Promise((_, reject) => { failResolve = reject; }));
    const onToast = vi.fn();
    const view = render(<AutomationControls sessionId="session-1" streaming={false} placement="approval" onToast={onToast} />);
    fireEvent.click(await screen.findByRole("button", { name: "拒绝" }));
    view.rerender(<AutomationControls sessionId="session-2" streaming={false} placement="approval" onToast={onToast} />);
    await act(async () => { failResolve(new Error("旧任务回复已失效")); });
    expect(onToast).not.toHaveBeenCalled();
    expect(screen.queryByText("旧任务确认")).toBeNull();
  });

  it("查询返回前收到新确认时仍保留快照中较早的待确认操作", async () => {
    const earlier = { requestId: "earlier", sessionId: "session-1", tool: "browser_click", title: "较早确认", description: "核对目标", details: {} };
    let finish!: (value: typeof earlier[]) => void;
    vi.mocked(automationClient.automationPendingApprovals).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    render(<AutomationControls sessionId="session-1" streaming={false} placement="approval" />);
    await waitFor(() => expect(automationClient.automationPendingApprovals).toHaveBeenCalled());
    const opened = vi.mocked(automationClient.onAutomationApproval).mock.calls[0][0];
    await act(async () => { opened({ ...earlier, requestId: "later", title: "较晚确认" }); finish([earlier]); });
    expect(screen.getByText("较早确认")).toBeInTheDocument();
    expect(screen.getByText("还有 1 个操作等待确认")).toBeInTheDocument();
  });
});
