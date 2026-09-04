// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("@/lib/agent-client", () => ({
  providersList: vi.fn().mockResolvedValue({ providers: [], models: [] }),
  agentsDefaultsGet: vi.fn().mockResolvedValue({
    defaultModel: "",
    defaultPermission: "",
    rememberToolApprovals: null,
  }),
  agentAuthStatus: vi.fn().mockResolvedValue({ ready: false, providers: [] }),
  commandsList: vi.fn().mockResolvedValue([]),
  exportTextFile: vi.fn().mockResolvedValue("/tmp/usage.csv"),
  echoAgentDataDir: vi.fn().mockResolvedValue("/tmp/.echo-agent"),
  mcpList: vi.fn().mockResolvedValue([]),
  notificationList: vi.fn().mockResolvedValue([]),
  notificationMarkRead: vi.fn().mockResolvedValue(undefined),
  notificationMarkAllRead: vi.fn().mockResolvedValue(undefined),
  notificationClear: vi.fn().mockResolvedValue(undefined),
  permissionList: vi.fn().mockResolvedValue([]),
  permissionSave: vi.fn().mockResolvedValue(undefined),
  skillsList: vi.fn().mockResolvedValue([]),
  subagentsConfigGet: vi.fn().mockResolvedValue({ maxDepth: 1 }),
  subagentsConfigSave: vi.fn().mockResolvedValue(1),
  webSearchConfigGet: vi.fn().mockResolvedValue({ enabled: false, model: "" }),
  webSearchConfigSave: vi.fn().mockResolvedValue(undefined),
  memoryConfigGet: vi.fn().mockResolvedValue({
    enabled: true,
    initialInjectionEnabled: true,
    saveOnEnd: true,
    watcherEnabled: true,
    autoFlushEnabled: true,
    dreamEnabled: true,
  }),
  memoryConfigSave: vi.fn(async (memory) => memory),
  memoryFlush: vi.fn(),
  memoryDream: vi.fn(),
  openExternalUrl: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/org-client", () => ({
  orgSession: vi.fn().mockResolvedValue({ loggedIn: false }),
  orgSyncModelConfig: vi.fn(),
  listenOrgModelsChanged: vi.fn().mockResolvedValue(() => {}),
}));

import { SettingsPanel } from "../SettingsPanel";
import { ThemeProvider } from "../ThemeProvider";
import {
  memoryConfigSave,
  notificationList,
  openExternalUrl,
  permissionList,
  permissionSave,
  subagentsConfigGet,
  subagentsConfigSave,
  webSearchConfigGet,
  webSearchConfigSave,
} from "@/lib/agent-client";

function renderSettings() {
  return render(
    <ThemeProvider>
      <SettingsPanel open onClose={() => {}} />
    </ThemeProvider>,
  );
}

describe("SettingsPanel", () => {
  it("打开后置焦点、圈定 Tab，Escape 关闭并恢复原焦点", async () => {
    const opener = document.createElement("button");
    opener.textContent = "打开设置";
    document.body.appendChild(opener);
    opener.focus();
    const onClose = vi.fn();
    const { rerender } = render(
      <ThemeProvider>
        <SettingsPanel open onClose={onClose} />
      </ThemeProvider>,
    );

    const close = screen.getByRole("button", { name: "关闭设置" });
    expect(close).toHaveFocus();
    const dialog = screen.getByRole("dialog", { name: "设置" });
    const focusable = Array.from(dialog.querySelectorAll<HTMLButtonElement>("button:not([disabled])"));
    focusable[focusable.length - 1]?.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(focusable[0]).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(
      <ThemeProvider>
        <SettingsPanel open={false} onClose={onClose} />
      </ThemeProvider>,
    );
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it("按使用场景分组全部设置入口，并默认打开模型页", async () => {
    const { container } = renderSettings();

    for (const group of ["通知", "智能体", "应用", "数据与支持"]) {
      expect(screen.getByRole("heading", { name: group, level: 2 })).toBeInTheDocument();
    }

    expect(container.querySelectorAll(".settings-navigation__item")).toHaveLength(11);
    expect(screen.getByRole("button", { name: "Token 用量" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "模型" })).toHaveAttribute("aria-current", "page");
    expect(await screen.findByRole("heading", { name: "模型与连接", level: 2 })).toBeInTheDocument();
    expect(screen.getByText("组织模型自动同步；个人 API 连接保存在本机并可挂载多个模型。"))
      .toBeInTheDocument();
  });

  it("允许 Slash 命令直接打开指定设置页", async () => {
    render(
      <ThemeProvider>
        <SettingsPanel open initialSection="help" onClose={() => {}} />
      </ThemeProvider>,
    );

    expect(screen.getByRole("button", { name: "帮助与反馈" }))
      .toHaveAttribute("aria-current", "page");
    expect(await screen.findByRole("heading", { name: "帮助与反馈", level: 2 }))
      .toBeInTheDocument();
  });

  it("通过桌面端系统浏览器打开帮助资源", async () => {
    render(
      <ThemeProvider>
        <SettingsPanel open initialSection="help" onClose={() => {}} />
      </ThemeProvider>,
    );

    fireEvent.click(await screen.findByRole("link", { name: /EchoAgent 文档/ }));

    await waitFor(() => {
      expect(openExternalUrl).toHaveBeenCalledWith("https://fuyuxiang.github.io/echo-agent/");
    });
  });

  it("所有设置入口都能进入对应页面并更新当前页状态", async () => {
    renderSettings();

    const pages = [
      "通知中心",
      "模型与连接",
      "智能体设置",
      "记忆",
      "系统设置",
      "个性化",
      "快捷键",
      "数据管理",
      "安全中心",
      "帮助与反馈",
    ];

    for (const page of pages) {
      const navigationItem = screen.getByRole("button", { name: page === "模型与连接" ? "模型" : page });
      fireEvent.click(navigationItem);
      expect(await screen.findByRole("heading", { name: page, level: 2 })).toBeInTheDocument();
      expect(navigationItem).toHaveAttribute("aria-current", "page");
    }
  }, 15_000);

  it("移除助理设置，并将智能体邮箱统一显示为通知中心", async () => {
    renderSettings();

    expect(screen.queryByRole("button", { name: "助理设置" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "账户管理" })).not.toBeInTheDocument();
    expect(screen.queryByText("智能体邮箱")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "通知中心" }));
    expect(await screen.findByRole("heading", { name: "通知中心" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "通知概览", level: 3 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "通知记录", level: 3 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "全部" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "全部已读" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "清空" })).toBeDisabled();
  });

  it("通知类型可按后端 snake_case 值筛选", async () => {
    vi.mocked(notificationList).mockResolvedValueOnce([
      {
        id: 1,
        kind: "folder_trust",
        at: "2026-09-04T20:00:00+08:00",
        title: "需要信任工作区",
        severity: "warn",
        read: false,
      },
      {
        id: 2,
        kind: "info",
        at: "2026-09-04T20:01:00+08:00",
        title: "普通通知",
        severity: "info",
        read: true,
      },
    ]);
    render(
      <ThemeProvider>
        <SettingsPanel open initialSection="agent-mail" onClose={() => {}} />
      </ThemeProvider>,
    );

    expect(await screen.findByText("需要信任工作区")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "文件夹信任" }));
    expect(screen.getByText("需要信任工作区")).toBeInTheDocument();
    expect(screen.queryByText("普通通知")).not.toBeInTheDocument();
  });

  it("通知文件损坏时显示可恢复错误而不是伪装成空列表", async () => {
    vi.mocked(notificationList).mockRejectedValueOnce(new Error("解析通知记录失败"));
    render(
      <ThemeProvider>
        <SettingsPanel open initialSection="agent-mail" onClose={() => {}} />
      </ThemeProvider>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "通知记录不可用：解析通知记录失败。原文件未被覆盖；你可以修复文件后重试，或点击“清空”重建。",
    );
    expect(screen.getByRole("button", { name: "清空" })).toBeEnabled();
  });

  it("记忆开关保存完整配置", async () => {
    render(
      <ThemeProvider>
        <SettingsPanel open initialSection="memory" onClose={() => {}} />
      </ThemeProvider>,
    );

    const autoFlush = await screen.findByRole("checkbox", { name: "自动落盘" });
    expect(autoFlush).toBeChecked();
    fireEvent.click(autoFlush);

    await waitFor(() => {
      expect(memoryConfigSave).toHaveBeenCalledWith(expect.objectContaining({
        enabled: true,
        autoFlushEnabled: false,
      }));
    });
    expect(
      screen.getByText("记忆配置已保存，重启 Agent 后对新会话生效。"),
    ).toBeInTheDocument();
  });

  it("运行时配置分项读取失败时不使用默认值且禁止保存", async () => {
    vi.mocked(subagentsConfigGet).mockRejectedValueOnce(new Error("子代理配置损坏"));
    vi.mocked(webSearchConfigGet).mockRejectedValueOnce(new Error("Web 配置不可读"));
    const { container } = render(
      <ThemeProvider>
        <SettingsPanel open initialSection="agent-settings" onClose={() => {}} />
      </ThemeProvider>,
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("子代理配置：子代理配置损坏");
    expect(alert).toHaveTextContent("Web 搜索配置：Web 配置不可读");
    const depth = container.querySelector<HTMLInputElement>('input[type="number"]');
    const webModel = screen.getByPlaceholderText("搜索模型 ID，如 search-model");
    expect(depth).toBeDisabled();
    expect(depth).toHaveValue(null);
    expect(webModel).toBeDisabled();
    expect(subagentsConfigSave).not.toHaveBeenCalled();
    expect(webSearchConfigSave).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(depth).toBeEnabled();
    expect(depth).toHaveValue(1);
    expect(webModel).toBeEnabled();
  });

  it("权限规则加载失败时不伪装空列表或允许覆盖，重试后恢复", async () => {
    vi.mocked(permissionList)
      .mockReset()
      .mockRejectedValueOnce(new Error("权限配置损坏"))
      .mockResolvedValueOnce([{ action: "deny", tool: "bash", pattern: "rm *" }]);
    vi.mocked(permissionSave).mockClear();
    render(
      <ThemeProvider>
        <SettingsPanel open initialSection="security" onClose={() => {}} />
      </ThemeProvider>,
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("权限规则读取失败：权限配置损坏");
    expect(screen.queryByText("尚未添加自定义权限规则")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存全部规则" })).toBeDisabled();
    expect(permissionSave).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByText("rm *")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存全部规则" })).toBeEnabled();
  });
});
