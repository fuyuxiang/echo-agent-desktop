// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("@/lib/agent-client", () => ({
  providersList: vi.fn().mockResolvedValue({ providers: [], models: [] }),
  accountGetApiKey: vi.fn().mockResolvedValue(null),
  agentAuthStatus: vi.fn().mockResolvedValue({ ready: false, providers: [] }),
  commandsList: vi.fn().mockResolvedValue([]),
  echoAgentDataDir: vi.fn().mockResolvedValue("/tmp/.echo-agent"),
  mcpList: vi.fn().mockResolvedValue([]),
  notificationList: vi.fn().mockResolvedValue([]),
  notificationMarkRead: vi.fn().mockResolvedValue(undefined),
  notificationMarkAllRead: vi.fn().mockResolvedValue(undefined),
  notificationClear: vi.fn().mockResolvedValue(undefined),
  permissionList: vi.fn().mockResolvedValue([]),
  skillsList: vi.fn().mockResolvedValue([]),
  subagentsConfigGet: vi.fn().mockResolvedValue({ maxDepth: 1 }),
  webSearchConfigGet: vi.fn().mockResolvedValue({ enabled: false, model: "" }),
}));

import { SettingsPanel } from "../SettingsPanel";
import { ThemeProvider } from "../ThemeProvider";

function renderSettings() {
  return render(
    <ThemeProvider>
      <SettingsPanel open onClose={() => {}} />
    </ThemeProvider>,
  );
}

describe("SettingsPanel", () => {
  it("按使用场景分组全部设置入口，并默认打开模型页", async () => {
    const { container } = renderSettings();

    for (const group of ["账户", "智能体", "应用", "数据与支持"]) {
      expect(screen.getByRole("heading", { name: group, level: 2 })).toBeInTheDocument();
    }

    expect(container.querySelectorAll(".settings-navigation__item")).toHaveLength(11);
    expect(screen.getByRole("button", { name: "模型" })).toHaveAttribute("aria-current", "page");
    expect(await screen.findByRole("heading", { name: "模型", level: 2 })).toBeInTheDocument();
    expect(screen.getByText("管理模型厂商、访问凭据和可用模型。每个厂商可以共享一套连接配置。"))
      .toBeInTheDocument();
  });

  it("所有设置入口都能进入对应页面并更新当前页状态", async () => {
    renderSettings();

    const pages = [
      "账户管理",
      "通知中心",
      "模型",
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
      const navigationItem = screen.getByRole("button", { name: page });
      fireEvent.click(navigationItem);
      expect(await screen.findByRole("heading", { name: page, level: 2 })).toBeInTheDocument();
      expect(navigationItem).toHaveAttribute("aria-current", "page");
    }
  });

  it("移除助理设置，并将智能体邮箱统一显示为通知中心", async () => {
    renderSettings();

    expect(screen.queryByRole("button", { name: "助理设置" })).not.toBeInTheDocument();
    expect(screen.queryByText("智能体邮箱")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "通知中心" }));
    expect(await screen.findByRole("heading", { name: "通知中心" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "通知概览", level: 3 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "通知记录", level: 3 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "全部" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "全部已读" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "清空" })).toBeDisabled();
  });
});
