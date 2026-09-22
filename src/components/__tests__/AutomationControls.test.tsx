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

  it("禁用后端判定不可用的模式，并展示隐私和数据清理入口", async () => {
    render(
      <AutomationControls
        sessionId="session-1"
        streaming={false}
        placement="toolbar"
      />,
    );

    await screen.findByText("Chrome 将在需要时自动启动");
    expect(screen.getByRole("option", { name: "Computer Use" })).toBeDisabled();
    expect(screen.getByText("内容将发送给当前模型")).toBeInTheDocument();
    const clearTrigger = screen.getByRole("button", { name: "清除数据" });
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
});
