import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { PluginsPanel } from "../PluginsPanel";
import { pluginsList } from "@/lib/agent-client";

vi.mock("@/lib/agent-client", () => ({
  pluginsList: vi.fn(),
  pluginsAction: vi.fn(),
}));

describe("PluginsPanel load states", () => {
  it("keeps a failed load distinct from a successful empty list and allows retry", async () => {
    vi.mocked(pluginsList)
      .mockRejectedValueOnce(new Error("目录不可用"))
      .mockResolvedValueOnce({ plugins: [] });
    render(<PluginsPanel />);
    expect(await screen.findByRole("alert")).toHaveTextContent("目录不可用");
    expect(screen.getByText("插件列表未加载")).toBeInTheDocument();
    expect(screen.queryByText("暂无插件。")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("暂无插件。")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the last loaded plugins when refresh fails", async () => {
    vi.mocked(pluginsList)
      .mockResolvedValueOnce({ plugins: [{ name: "评审插件", enabled: true, trusted: true, scope: "user" }] })
      .mockRejectedValueOnce(new Error("暂时无法刷新"));
    render(<PluginsPanel />);
    expect(await screen.findByText("评审插件")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("下方保留上次加载的结果");
    expect(screen.getByText("评审插件")).toBeInTheDocument();
    expect(screen.queryByText("暂无插件。")).toBeNull();
  });

  it("discards a previous project's delayed plugin list after switching sessions", async () => {
    let resolveOld!: (value: { plugins: { name: string; enabled: boolean; trusted: boolean }[] }) => void;
    vi.mocked(pluginsList)
      .mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce({ plugins: [{ name: "当前项目插件", enabled: true, trusted: true }] });
    const { rerender } = render(<PluginsPanel sessionId="old-session" />);
    rerender(<PluginsPanel sessionId="new-session" />);
    expect(await screen.findByText("当前项目插件")).toBeInTheDocument();
    await act(async () => resolveOld({ plugins: [{ name: "旧项目插件", enabled: true, trusted: true }] }));
    expect(screen.queryByText("旧项目插件")).toBeNull();
    expect(screen.getByText("当前项目插件")).toBeInTheDocument();
  });
});
