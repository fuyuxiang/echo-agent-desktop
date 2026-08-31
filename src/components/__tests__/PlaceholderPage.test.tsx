import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("../experts-panel", () => ({
  ExpertsPanel: ({ initialTab }: { initialTab?: string }) => (
    <div data-testid="experts-panel">{initialTab}</div>
  ),
}));
vi.mock("../PluginsPanel", () => ({
  PluginsPanel: () => <div>installed plugins</div>,
}));
vi.mock("../MarketplacePanel", () => ({
  MarketplacePanel: () => <div>plugin marketplace</div>,
}));

import { PlaceholderPage } from "../PlaceholderPage";

describe("PlaceholderPage", () => {
  it("未注册路由显示明确错误，不伪装成待上线功能", () => {
    render(<PlaceholderPage label="某个未实现功能" />);
    expect(screen.getByRole("heading", { name: "无法打开「某个未实现功能」" })).toBeInTheDocument();
    expect(screen.getByText(/未注册该功能路由/)).toBeInTheDocument();
  });

  it.each(["助理", "灵感", "网页预览", "策略设置", "发现"])(
    "已移除路由「%s」不会再渲染旧功能页",
    (label) => {
      render(<PlaceholderPage label={label} />);
      expect(
        screen.getByRole("heading", { name: `无法打开「${label}」` }),
      ).toBeInTheDocument();
    },
  );

  it.each([
    ["专家·技能·连接器", "experts"],
    ["技能", "skills"],
    ["连接器", "connectors"],
  ])("Slash 路由「%s」直达 %s 页签", (label, tab) => {
    render(<PlaceholderPage label={label} />);
    expect(screen.getByTestId("experts-panel")).toHaveTextContent(tab);
  });

  it("插件市场 Slash 路由直达市场页签", () => {
    render(<PlaceholderPage label="插件市场" />);
    expect(screen.getByText("plugin marketplace")).toBeInTheDocument();
    expect(screen.queryByText("installed plugins")).not.toBeInTheDocument();
  });
});
