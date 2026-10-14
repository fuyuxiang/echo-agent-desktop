import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  action: vi.fn(),
  openUrl: vi.fn(),
}));

vi.mock("@/lib/agent-client", () => ({
  marketplaceList: mocks.list,
  marketplaceAction: mocks.action,
  openUrl: mocks.openUrl,
}));

import { MarketplacePanel } from "../MarketplacePanel";

describe("MarketplacePanel 外部链接", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.list.mockResolvedValue({
      sources: [{
        sourceName: "不受信目录",
        sourceKind: "git",
        sourceUrlOrPath: "https://example.test/catalog.git",
        plugins: [{
          name: "Demo Plugin",
          relativePath: "plugins/demo",
          homepage: "javascript:alert(1)",
          skillCount: 0,
          hasHooks: false,
          hasAgents: false,
          hasMcp: false,
          installStatus: "available",
        }],
      }],
    });
    mocks.openUrl.mockRejectedValue(new Error("不允许的 URL scheme"));
  });

  it("不把 catalog URL 放进 href，并在后端拒绝时显示错误", async () => {
    const onToast = vi.fn();
    render(<MarketplacePanel sessionId="session-1" onToast={onToast} />);

    const homepage = await screen.findByRole("button", { name: "主页" });
    expect(screen.queryByRole("link", { name: "主页" })).not.toBeInTheDocument();
    fireEvent.click(homepage);

    await waitFor(() => expect(mocks.openUrl).toHaveBeenCalledWith("javascript:alert(1)"));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("无法打开「Demo Plugin」主页：不允许的 URL scheme");
    expect(onToast).toHaveBeenCalledWith(expect.stringContaining("无法打开「Demo Plugin」主页"));
  });

  it("首次加载失败不伪装成空市场，并可重试", async () => {
    mocks.list.mockRejectedValueOnce(new Error("catalog offline"));
    render(<MarketplacePanel sessionId="session-1" />);

    expect(await screen.findByRole("alert")).toHaveTextContent("catalog offline");
    expect(screen.queryByText("暂无市场源。")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("Demo Plugin")).toBeInTheDocument();
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it("添加源入口与提交按钮共用可见的主操作状态", async () => {
    mocks.list.mockResolvedValue({ sources: [] });
    mocks.action.mockResolvedValue({ ok: true });
    const onToast = vi.fn();
    render(<MarketplacePanel sessionId="session-1" onToast={onToast} />);

    const openButton = await screen.findByRole("button", { name: "添加源" });
    expect(openButton).toHaveClass("marketplace-panel__action-btn--primary");

    fireEvent.click(openButton);
    const urlInput = screen.getByRole("textbox", { name: "市场源 Git URL" });
    const addButton = screen.getByRole("button", { name: "添加" });
    expect(addButton).toHaveClass("marketplace-panel__action-btn--primary");
    expect(addButton).toBeDisabled();

    fireEvent.change(urlInput, {
      target: { value: "https://github.com/example/marketplace.git" },
    });
    expect(addButton).toBeEnabled();
    fireEvent.click(addButton);

    await waitFor(() => expect(mocks.action).toHaveBeenCalledWith("session-1", {
      type: "add_source",
      url: "https://github.com/example/marketplace.git",
    }));
    expect(onToast).toHaveBeenCalledWith(
      "已添加源 https://github.com/example/marketplace.git",
    );
    await waitFor(() => expect(
      screen.queryByRole("textbox", { name: "市场源 Git URL" }),
    ).toBeNull());
  });

  it("移除确认明确说明当前 Echo 范围、管理安装卸载和外部文件保留", async () => {
    render(<MarketplacePanel sessionId="session-1" />);
    await screen.findByText("Demo Plugin");
    fireEvent.click(screen.getByRole("button", { name: "移除源" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("当前 Echo 配置");
    expect(dialog).toHaveTextContent("卸载从该源安装在 Echo 管理目录中的插件");
    expect(dialog).toHaveTextContent("其他应用的配置和文件将保留");
    expect(mocks.action).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(mocks.action).not.toHaveBeenCalled();
  });

  it("Runtime update_available remains installed and exposes update instead of reinstall", async () => {
    const source = { sourceName: 'Owned Catalog', sourceKind: 'git', sourceUrlOrPath: 'https://example.test/owned.git',
      plugins: [{ name: 'Owned Plugin', relativePath: 'plugins/owned', version: '2.0.0', installedVersion: '1.0.0',
        installStatus: 'update_available', skillCount: 1, hasHooks: false, hasAgents: false, hasMcp: false }] };
    mocks.list.mockResolvedValue({ sources: [source] }); mocks.action.mockResolvedValue({ status: 'success' });
    render(<MarketplacePanel sessionId="session-1" />);
    const update = await screen.findByRole('button', { name: '更新' });
    expect(screen.getByText(/已安装.*v1\.0\.0/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '卸载' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '安装' })).not.toBeInTheDocument();
    mocks.list.mockResolvedValue({ sources: [{ ...source, plugins: [{ ...source.plugins[0], installStatus: 'installed', installedVersion: '2.0.0' }] }] });
    fireEvent.click(update);
    await waitFor(() => expect(mocks.action).toHaveBeenCalledWith('session-1', { type: 'update',
      sourceUrlOrPath: source.sourceUrlOrPath, pluginRelativePath: 'plugins/owned' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: '更新' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: '卸载' })).toBeInTheDocument();
  });
});
