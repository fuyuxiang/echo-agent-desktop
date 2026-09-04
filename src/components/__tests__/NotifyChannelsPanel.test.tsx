import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { NotifyChannel } from "@/lib/notify-channels";

const backend = vi.hoisted(() => {
  let channels: NotifyChannel[] = [];
  return {
    reset: () => { channels = []; },
    seed: (items: NotifyChannel[]) => { channels = items; },
    load: vi.fn(async () => channels.map((item) => ({ ...item }))),
    save: vi.fn(async (channel: NotifyChannel) => {
      channels = [...channels.filter((item) => item.id !== channel.id), channel];
    }),
    remove: vi.fn(async (id: string) => {
      channels = channels.filter((item) => item.id !== id);
    }),
    setEnabled: vi.fn(async (id: string, enabled: boolean) => {
      channels = channels.map((item) => item.id === id ? { ...item, enabled } : item);
    }),
    test: vi.fn(async (id: string) => ({ id, ok: true })),
  };
});

vi.mock("@/lib/notify-channels", () => ({
  loadNotifyChannels: backend.load,
  saveNotifyChannel: backend.save,
  removeNotifyChannel: backend.remove,
  setNotifyChannelEnabled: backend.setEnabled,
  testNotifyChannel: backend.test,
}));

import { NotifyChannelsPanel } from "../NotifyChannelsPanel";

describe("NotifyChannelsPanel", () => {
  beforeEach(() => {
    backend.reset();
    vi.clearAllMocks();
  });

  it("无渠道时显示空态", async () => {
    render(<NotifyChannelsPanel />);
    await waitFor(() => expect(backend.load).toHaveBeenCalled());
    expect(screen.getByText("暂无通知渠道")).toBeInTheDocument();
  });

  it("添加渠道后持久化并显示在列表", async () => {
    render(<NotifyChannelsPanel onToast={vi.fn()} />);
    const inputs = screen.getAllByRole("textbox");
    fireEvent.change(inputs[0], { target: { value: "我的Slack" } });
    fireEvent.change(inputs[1], { target: { value: "https://hooks.slack.com/x" } });
    fireEvent.click(screen.getByText("+ 添加"));
    await waitFor(() => expect(screen.getByText("我的Slack")).toBeInTheDocument());
    expect(backend.save).toHaveBeenCalledWith(expect.objectContaining({
      label: "我的Slack",
      endpoint: "https://hooks.slack.com/x",
      enabled: true,
    }));
  });

  it("移除渠道", async () => {
    backend.seed([{ id: "test", label: "Test", kind: "generic-webhook", enabled: true }]);
    render(<NotifyChannelsPanel onToast={vi.fn()} />);
    await screen.findByText("Test");
    fireEvent.click(screen.getByTitle("移除"));
    const dialog = screen.getByRole("alertdialog", { name: "移除通知渠道？" });
    expect(backend.remove).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "移除" }));
    await waitFor(() => expect(screen.queryByText("Test")).toBeNull());
    expect(backend.remove).toHaveBeenCalledWith("test");
  });

  it("移除失败时保留确认框并可重试", async () => {
    backend.seed([{ id: "test", label: "Test", kind: "generic-webhook", enabled: true }]);
    backend.remove.mockRejectedValueOnce(new Error("配置文件被占用"));
    render(<NotifyChannelsPanel onToast={vi.fn()} />);
    fireEvent.click(await screen.findByTitle("移除"));
    fireEvent.click(screen.getByRole("button", { name: "移除" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("配置文件被占用");
    expect(screen.getByText("Test")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "移除" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(backend.remove).toHaveBeenCalledTimes(2);
  });

  it("切换启用/禁用", async () => {
    backend.seed([{ id: "test", label: "Test", kind: "generic-webhook", enabled: true }]);
    render(<NotifyChannelsPanel />);
    fireEvent.click(await screen.findByTitle("禁用"));
    await waitFor(() => expect(screen.getByTitle("启用")).toBeInTheDocument());
    expect(backend.setEnabled).toHaveBeenCalledWith("test", false);
  });

  it("测试发送调用后端测试命令", async () => {
    backend.seed([{
      id: "test",
      label: "Webhook",
      kind: "generic-webhook",
      endpoint: "http://localhost:9999/hook",
      enabled: true,
    }]);
    const onToast = vi.fn();
    render(<NotifyChannelsPanel onToast={onToast} />);
    fireEvent.click(await screen.findByText("测试"));
    await waitFor(() => expect(onToast).toHaveBeenCalledWith("测试通知已发送"));
    expect(backend.test).toHaveBeenCalledWith("test");
  });
});
