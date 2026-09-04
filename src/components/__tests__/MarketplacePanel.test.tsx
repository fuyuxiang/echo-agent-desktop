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
});
