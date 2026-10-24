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

  it("普通电脑任务只展示进度，没有专用控制按钮或技术状态", async () => {
    useSessionStore.setState({agentMode:"computer_use"});
    vi.mocked(automationClient.automationStatus).mockResolvedValue({...availableStatus,mode:"computer_use",computer:{available:true,platform:"macOS",screenCapture:true,inputControl:true}});
    render(<AutomationControls sessionId="session-1" streaming placement="toolbar" />);
    expect(await screen.findByText("正在处理任务，可随时说“停一下”")).toBeInTheDocument();
    for(const name of ["继续","接管","结束","操作电脑","更多自动化选项"]) expect(screen.queryByRole("button",{name})).toBeNull();
    expect(screen.queryByText(/截图控制|原生控件/)).toBeNull();
  });

  it("系统授权仍有效时也显示桌面会话中断", async () => {
    useSessionStore.setState({ agentMode: "computer_use" });
    vi.mocked(automationClient.automationStatus).mockResolvedValue({
      ...availableStatus, mode: "computer_use",
      computer: { available: true, platform: "macOS", screenCapture: true, inputControl: true,
        desktopAvailable: false, reason: "桌面暂不可用，请解锁电脑后发送“继续”",
        accessibility: { supported: true, authorization: "granted", probe: "succeeded" } },
    });
    render(<AutomationControls sessionId="session-1" streaming={false} placement="toolbar" />);
    expect(await screen.findByText("桌面暂不可用，请解锁电脑后发送“继续”")).toBeInTheDocument();
    expect(screen.queryByText("原生控件探测成功 · 截图控制已就绪")).not.toBeInTheDocument();
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
  it("范围扩大或敏感动作只确认具体操作，不提供扩大任务授权按钮", async () => {
    vi.mocked(automationClient.automationPendingApprovals).mockResolvedValue([{
      requestId:"decision",sessionId:"session-1",tool:"computer_invoke",title:"确认发送",description:"核对收件人",details:{name:"发送"},
    }]);
    render(<AutomationControls sessionId="session-1" streaming={false} placement="approval" />);
    fireEvent.click(await screen.findByRole("button",{name:"允许本次"}));
    expect(automationClient.automationResolveApproval).toHaveBeenCalledWith("decision",true);
    expect(screen.queryByRole("button",{name:"允许本任务电脑操作"})).toBeNull();
  });
  it("原生操作确认显示实际应用、窗口和动作，不显示输入原文", async () => {
    vi.mocked(automationClient.automationPendingApprovals).mockResolvedValue([{
      requestId: "native-1", sessionId: "session-1", tool: "computer_set_value",
      title: "确认原生桌面操作", description: "核对目标", details: {
        application: "synthetic-app", windowName: "synthetic-document", role: "AXTextArea",
        name: "合成输入", identifier: "synthetic-entry", action: "computer_set_value", characters: 20,
      },
    }]);
    render(<AutomationControls sessionId="session-1" streaming={false} placement="approval" />);
    expect(await screen.findByText("synthetic-app")).toBeInTheDocument();
    expect(screen.getByText("synthetic-document")).toBeInTheDocument();
    expect(screen.getByText("合成输入")).toBeInTheDocument();
    expect(screen.getByText("AXTextArea")).toBeInTheDocument();
    expect(screen.getByText("computer_set_value")).toBeInTheDocument();
    expect(screen.getByText("20 个字符")).toBeInTheDocument();
  });

  it("浏览器数据清理保留针对性确认", async () => {
    render(<AutomationControls sessionId="session-1" streaming={false} placement="toolbar" />);
    fireEvent.click(await screen.findByText("浏览器数据与访问范围"));
    fireEvent.click(await screen.findByRole("button",{name:"清除浏览器数据"}));
    expect(await screen.findByText("清除该任务的浏览器数据？")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button",{name:"清除数据"}));
    await waitFor(()=>expect(automationClient.automationClearBrowserData).toHaveBeenCalledWith("session-1"));
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
    await screen.findByText("任务已暂停，发送“继续”即可续做");
    await act(async () => { finishOld(availableStatus); });
    expect(screen.getByText("任务已暂停，发送“继续”即可续做")).toBeInTheDocument();
  });

  it("较新的状态事件优先于正在返回的旧查询", async () => {
    let finish!: (value: typeof availableStatus) => void;
    vi.mocked(automationClient.automationStatus).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    render(<AutomationControls sessionId="session-1" streaming={false} placement="toolbar" />);
    await waitFor(() => expect(automationClient.automationStatus).toHaveBeenCalled());
    const onStatus = vi.mocked(automationClient.onAutomationStatus).mock.calls[0][0];
    await act(async () => { onStatus({ ...availableStatus, paused: true }); finish(availableStatus); });
    expect(screen.getByText("任务已暂停，发送“继续”即可续做")).toBeInTheDocument();
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
  it("重启后的任务显示续做提示，不自动恢复或重新授权", async () => {
    useSessionStore.setState({agentMode:"computer_use"});
    vi.mocked(automationClient.automationStatus).mockResolvedValue({...availableStatus,mode:"computer_use",paused:true,
      task:{phase:"paused",reason:"application_restarted",scope:"TextEdit",authorized:false,generation:0},
      computer:{available:true,platform:"macOS",screenCapture:true,inputControl:true}});
    render(<AutomationControls sessionId="session-1" streaming={false} placement="toolbar" />);
    expect(await screen.findByText("任务已保留，发送“继续”即可续做")).toBeInTheDocument();
    expect(automationClient.automationResume).not.toHaveBeenCalled();
    expect(screen.queryByRole("button",{name:"继续"})).toBeNull();
  });
});

it("暂停后的继续入口发送一次可信消息，拒绝发送时保持暂停", async () => {
  useSessionStore.setState({agentMode:"computer_use"});
  Object.defineProperty(window,"__TAURI_INTERNALS__",{configurable:true,value:{}});
  vi.mocked(automationClient.automationStatus).mockResolvedValue({...availableStatus,mode:"computer_use",paused:true,
    task:{phase:"paused",reason:"user_paused",scope:"TextEdit 文稿",authorized:false,generation:2},
    computer:{available:true,platform:"macOS",screenCapture:true,inputControl:true}});
  vi.mocked(automationClient.automationPendingApprovals).mockResolvedValue([]);
  let finish!: (value:boolean)=>void;
  const onContinue=vi.fn(()=>new Promise<boolean>(resolve=>{finish=resolve;}));
  render(<AutomationControls sessionId="session-1" streaming={false} placement="toolbar" onContinue={onContinue} />);
  const button=await screen.findByRole("button",{name:"继续任务"});
  fireEvent.click(button);
  fireEvent.click(button);
  expect(onContinue).toHaveBeenCalledTimes(1);
  expect(button).toBeDisabled();
  await act(async()=>{finish(false);});
  expect(screen.getByText("任务已暂停，发送“继续”即可续做")).toBeInTheDocument();
  expect(button).toBeEnabled();
  expect(automationClient.automationResume).not.toHaveBeenCalled();
});

it("两轮生成之间提供暂停入口，停止状态不再误报为暂停", async () => {
  useSessionStore.setState({agentMode:"computer_use"});
  Object.defineProperty(window,"__TAURI_INTERNALS__",{configurable:true,value:{}});
  vi.mocked(automationClient.automationStatus).mockResolvedValue({...availableStatus,mode:"computer_use",computerAuthorized:true,
    task:{phase:"running",reason:null,scope:"TextEdit 文稿",authorized:true,generation:1},
    computer:{available:true,platform:"macOS",screenCapture:true,inputControl:true}});
  vi.mocked(automationClient.automationPendingApprovals).mockResolvedValue([]);
  const onPause=vi.fn(async()=>true);
  const view=render(<AutomationControls sessionId="session-1" streaming={false} placement="toolbar" onPause={onPause} />);
  fireEvent.click(await screen.findByRole("button",{name:"暂停任务"}));
  await waitFor(()=>expect(onPause).toHaveBeenCalledTimes(1));
  view.unmount();
  vi.mocked(automationClient.automationStatus).mockResolvedValue({...availableStatus,mode:"computer_use",paused:true,
    task:{phase:"stopped",reason:"user_stopped",scope:"TextEdit 文稿",authorized:false,generation:2},
    computer:{available:true,platform:"macOS",screenCapture:true,inputControl:true}});
  render(<AutomationControls sessionId="session-1" streaming={false} placement="toolbar" />);
  expect(await screen.findByText("任务已停止，已有内容保留")).toBeInTheDocument();
});
