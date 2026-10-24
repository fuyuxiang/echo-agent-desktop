// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

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
  afterEach(() => vi.restoreAllMocks());

  async function capturePoll() {
    const timers = vi.spyOn(window, "setInterval");
    render(<WeixinChannelPanel />);
    await screen.findByRole("heading", { name: "已连接" });
    await waitFor(() => expect(timers).toHaveBeenCalledWith(expect.any(Function), 10_000));
    return timers.mock.calls.find(([, delay]) => delay === 10_000)![0] as () => void;
  }

  it("解除绑定后忽略旧轮询响应", async () => {
    let resolvePoll!: (status: typeof connectedStatus) => void;
    const pending = new Promise<typeof connectedStatus>(resolve => { resolvePoll = resolve; });
    backend.disconnect.mockResolvedValue(undefined);
    const callback = await capturePoll();
    backend.status.mockReturnValueOnce(pending);
    act(callback);
    fireEvent.click(screen.getByRole("button", { name: "解除绑定" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "解除绑定" }));
    await screen.findByRole("heading", { name: "绑定微信" });
    await act(async () => { resolvePoll(connectedStatus); await pending; });
    expect(screen.queryByRole("heading", { name: "已连接" })).toBeNull();
    expect(screen.getByRole("heading", { name: "绑定微信" })).toBeInTheDocument();
  });

  it("慢状态轮询不重叠", async () => {
    const callback = await capturePoll();
    let finish!: (status: typeof connectedStatus) => void;
    const pending = new Promise<typeof connectedStatus>(resolve => { finish = resolve; });
    backend.status.mockReturnValueOnce(pending);
    act(() => { callback(); callback(); });
    expect(backend.status).toHaveBeenCalledTimes(2);
    await act(async () => { finish(connectedStatus); await pending; });
  });

  it("保存授权后旧轮询不会恢复旧授权范围", async () => {
    const callback = await capturePoll();
    let finish!: (status: typeof connectedStatus) => void;
    const pending = new Promise<typeof connectedStatus>(resolve => { finish = resolve; });
    backend.status.mockReturnValueOnce(pending);
    act(callback);
    fireEvent.click(screen.getByRole("checkbox", { name: /\/repo\/B/ }));
    const save = screen.getByRole("button", { name: "保存访问范围" });
    fireEvent.click(save);
    await waitFor(() => expect(backend.setWorkspaces).toHaveBeenCalledOnce());
    await waitFor(() => expect(save).toBeDisabled());
    await act(async () => { finish(connectedStatus); await pending; });
    expect(save).toBeDisabled();
  });

  it("解绑后丢弃仍在途中的授权保存结果", async () => {
    let finish!: (status: typeof connectedStatus) => void;
    const pending = new Promise<typeof connectedStatus>(resolve => { finish = resolve; });
    backend.setWorkspaces.mockReturnValueOnce(pending);
    backend.disconnect.mockResolvedValue(undefined);
    render(<WeixinChannelPanel />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /\/repo\/B/ }));
    fireEvent.click(screen.getByRole("button", { name: "保存访问范围" }));
    fireEvent.click(screen.getByRole("button", { name: "解除绑定" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "解除绑定" }));
    await screen.findByRole("heading", { name: "绑定微信" });
    await act(async () => { finish(connectedStatus); await pending; });
    expect(screen.queryByRole("heading", { name: "已连接" })).toBeNull();
    expect(screen.getByRole("button", { name: "获取绑定二维码" })).toBeEnabled();
  });

  it("撤销交接后旧轮询不会恢复交接列表", async () => {
    const shared = { ...connectedStatus, sharedSessions: [{ sessionId: "session-one", cwd: "/repo/B", title: "单独任务" }] };
    backend.status.mockResolvedValue(shared);
    backend.revokeSession.mockResolvedValue(connectedStatus);
    const callback = await capturePoll();
    let finish!: (status: typeof shared) => void;
    const pending = new Promise<typeof shared>(resolve => { finish = resolve; });
    backend.status.mockReturnValueOnce(pending);
    act(callback);
    fireEvent.click(screen.getByText("单独交接的任务"));
    fireEvent.click(screen.getByRole("button", { name: "撤销 单独任务 的单独交接授权" }));
    await screen.findByText("暂无单独交接的任务。");
    await act(async () => { finish(shared); await pending; });
    expect(screen.getByText("暂无单独交接的任务。")).toBeInTheDocument();
  });

  it("解绑失败后仍可重试授权操作，不被已失效的保存请求锁住", async () => {
    let finish!: (status: typeof connectedStatus) => void;
    const pending = new Promise<typeof connectedStatus>(resolve => { finish = resolve; });
    backend.setWorkspaces.mockReturnValueOnce(pending);
    backend.disconnect.mockRejectedValueOnce(new Error("解绑失败"));
    render(<WeixinChannelPanel />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /\/repo\/B/ }));
    const save = screen.getByRole("button", { name: "保存访问范围" });
    fireEvent.click(save);
    fireEvent.click(screen.getByRole("button", { name: "解除绑定" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "解除绑定" }));
    await within(dialog).findByText("解绑失败");
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await act(async () => { finish(connectedStatus); await pending; });
    expect(save).toBeEnabled();
  });

  beforeEach(() => {
    vi.resetAllMocks();
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
    expect(screen.getByRole("heading", { name: "已连接" })).toBeInTheDocument();
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
