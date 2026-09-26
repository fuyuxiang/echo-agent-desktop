import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";

vi.mock("../experts-panel", () => ({
  ExpertsPanel: ({ initialTab, hideNavigation }: { initialTab?: string; hideNavigation?: boolean }) => (
    <div data-testid="experts-panel" data-embedded={hideNavigation}>{initialTab}</div>
  ),
}));
vi.mock("../PluginsPanel", () => ({
  PluginsPanel: () => <div>installed plugins</div>,
}));
vi.mock("../MarketplacePanel", () => ({
  MarketplacePanel: () => <div>plugin marketplace</div>,
}));
vi.mock("@/features/coding/CodingWorkbench", () => ({
  CodingWorkbench: () => <div>coding workbench</div>,
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
  ])("Slash 路由「%s」直达 %s 页签", async (label, tab) => {
    render(<PlaceholderPage label={label} />);
    expect(await screen.findByTestId("experts-panel")).toHaveTextContent(tab);
  });

  it("插件市场 Slash 路由直达市场页签", async () => {
    render(<PlaceholderPage label="插件市场" />);
    expect(await screen.findByText("plugin marketplace")).toBeInTheDocument();
    expect(screen.queryByText("installed plugins")).not.toBeInTheDocument();
  });

  it("代码开发路由加载专属工作台", async () => {
    render(<PlaceholderPage label="代码开发" />);
    expect(await screen.findByText("coding workbench")).toBeInTheDocument();
  });

  it("能力页面保持单层导航，可往返所有类别和市场", async () => {
    function Page() {
      const [label, setLabel] = useState("专家·技能·连接器");
      return <PlaceholderPage label={label} onNavigate={setLabel} />;
    }
    render(<Page />);
    const panel = await screen.findByTestId("experts-panel");
    expect(panel).toHaveAttribute("data-embedded", "true");
    expect(screen.queryByText("专家、技能与连接器")).toBeNull();
    expect(screen.getAllByRole("navigation", { name: "能力管理" })).toHaveLength(1);
    const nav = screen.getByRole("navigation", { name: "能力管理" });
    for (const [label, content] of [["技能", "skills"], ["连接器", "connectors"], ["专家", "experts"]]) {
      fireEvent.click(within(nav).getByRole("button", { name: label }));
      expect(await screen.findByTestId("experts-panel")).toHaveTextContent(content);
      expect(within(nav).getByRole("button", { name: label })).toHaveAttribute("aria-current", "page");
    }
    fireEvent.click(within(nav).getByRole("button", { name: "插件" }));
    expect(await screen.findByText("installed plugins")).toBeInTheDocument();
    fireEvent.click(within(nav).getByRole("button", { name: "浏览市场" }));
    expect(await screen.findByText("plugin marketplace")).toBeInTheDocument();
    expect(screen.queryByText("installed plugins")).toBeNull();
    fireEvent.click(within(nav).getByRole("button", { name: "专家" }));
    expect(await screen.findByTestId("experts-panel")).toHaveTextContent("experts");
  });
});
