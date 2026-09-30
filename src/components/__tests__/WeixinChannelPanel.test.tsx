// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const backend = vi.hoisted(() => ({
  invoke: vi.fn(),
  status: vi.fn(),
  qrStart: vi.fn(),
  qrPoll: vi.fn(),
  setWorkspaces: vi.fn(),
  revokeSession: vi.fn(),
  disconnect: vi.fn(),
  qrImage: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: backend.invoke }));
vi.mock("qrcode", () => ({ default: { toDataURL: backend.qrImage } }));
vi.mock("@/lib/weixin-client", () => ({
  weixinStatus: backend.status,
  weixinQrStart: backend.qrStart,
  weixinQrPoll: backend.qrPoll,
  weixinSetWorkspaces: backend.setWorkspaces,
  weixinRevokeSession: backend.revokeSession,
  weixinDisconnect: backend.disconnect,
}));

import { WeixinChannelPanel } from "../WeixinChannelPanel";

const connectedStatus = {
  connected: true,
  online: true,
  botId: "bot-1",
  allowedWorkspaces: ["/repo/A"],
  defaultWorkspace: "/repo/A",
  sharedSessions: [],
  pendingReplies: 0,
};

describe("WeixinChannelPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    backend.invoke.mockResolvedValue([
      { cwd: "/repo/A", sessionCount: 2 },
      { cwd: "/repo/B", sessionCount: 1 },
    ]);
    backend.status.mockResolvedValue(connectedStatus);
    backend.setWorkspaces.mockImplementation(async (workspaces: string[], defaultWorkspace: string) => ({
      ...connectedStatus,
      allowedWorkspaces: workspaces,
      defaultWorkspace,
    }));
    backend.qrStart.mockResolvedValue({ qrUrl: "https://example.test/bind" });
    backend.qrPoll.mockResolvedValue({ status: "expired", connected: false });
    backend.qrImage.mockResolvedValue("data:image/png;base64,cXI=");
  });

  it("在消息通道中加载微信状态并保存工作区授权", async () => {
    const onToast = vi.fn();
    render(<WeixinChannelPanel onToast={onToast} />);

    expect(await screen.findByRole("heading", { name: "授权工作区" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "微信远程对话" })).toBeInTheDocument();
    expect(backend.status).toHaveBeenCalledOnce();
    expect(backend.invoke).toHaveBeenCalledWith("agent_list_workspaces");
    expect(screen.getByRole("checkbox", { name: /\/repo\/A/ })).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: /\/repo\/B/ }));
    fireEvent.click(screen.getByRole("button", { name: "保存访问范围" }));

    await waitFor(() => expect(backend.setWorkspaces).toHaveBeenCalledWith(["/repo/A", "/repo/B"], "/repo/A"));
    expect(onToast).toHaveBeenCalledWith("微信可访问的工作区已保存");
    expect(screen.getByRole("button", { name: "保存访问范围" })).toBeDisabled();
  });

  it("可单独调整默认工作区，且不改变授权范围", async () => {
    render(<WeixinChannelPanel />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /\/repo\/B/ }));
    fireEvent.click(screen.getByRole("radio", { name: "设为默认工作区 /repo/B" }));
    fireEvent.click(screen.getByRole("button", { name: "保存访问范围" }));
    await waitFor(() => expect(backend.setWorkspaces).toHaveBeenCalledWith(["/repo/A", "/repo/B"], "/repo/B"));
  });

  it("工作区读取失败时仍展示绑定状态并允许重试", async () => {
    backend.invoke.mockRejectedValueOnce("暂时无法读取");
    render(<WeixinChannelPanel />);
    expect(await screen.findByRole("heading", { name: "已连接" })).toBeInTheDocument();
    expect(screen.getByText(/工作区列表读取失败/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("checkbox", { name: /\/repo\/A/ })).toBeChecked();
  });

  it("已授权但不在当前目录列表的工作区仍可取消授权", async () => {
    backend.status.mockResolvedValueOnce({
      ...connectedStatus,
      allowedWorkspaces: ["/repo/old"],
      defaultWorkspace: "/repo/old",
    });
    render(<WeixinChannelPanel />);
    const stale = await screen.findByRole("checkbox", { name: "/repo/old" });
    expect(stale).toBeChecked();
    fireEvent.click(stale);
    fireEvent.click(screen.getByRole("button", { name: "保存访问范围" }));
    await waitFor(() => expect(backend.setWorkspaces).toHaveBeenCalledWith([], undefined));
  });

  it("绑定状态读取失败时可重试而不丢失工作区数据", async () => {
    backend.status.mockRejectedValueOnce("凭据暂时不可用");
    render(<WeixinChannelPanel />);
    expect(await screen.findByText(/绑定状态读取失败/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("heading", { name: "已连接" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /\/repo\/A/ })).toBeChecked();
  });

  it("未绑定时仍能获取二维码并展示扫码入口", async () => {
    backend.status.mockResolvedValueOnce({
      connected: false,
      online: false,
      allowedWorkspaces: [],
      sharedSessions: [],
      pendingReplies: 0,
    });
    render(<WeixinChannelPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "获取绑定二维码" }));
    expect(await screen.findByRole("img", { name: "微信绑定二维码" })).toBeInTheDocument();
    expect(backend.qrStart).toHaveBeenCalledOnce();
    expect(backend.qrPoll).toHaveBeenCalledOnce();
  });
});
