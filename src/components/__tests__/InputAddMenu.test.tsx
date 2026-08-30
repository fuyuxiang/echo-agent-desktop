import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/agent-client", () => ({
  agentsList: vi.fn().mockResolvedValue([]),
  skillsList: vi.fn().mockResolvedValue([]),
  mcpList: vi.fn().mockResolvedValue([
    { name: "真实服务", target: "https://mcp.example.com", enabled: true },
    { name: "已停用服务", target: "https://disabled.example.com", enabled: false },
  ]),
}));

import { InputAddMenu } from "../InputAddMenu";

describe("InputAddMenu", () => {
  it("连接器子菜单只展示后端实际启用的 MCP 服务", async () => {
    const onNavigateConnectors = vi.fn();
    render(
      <InputAddMenu
        onPickFiles={vi.fn()}
        onNavigateConnectors={onNavigateConnectors}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    const connectorRow = screen.getByText("连接器").closest(".iam-item");
    expect(connectorRow).not.toBeNull();
    fireEvent.mouseEnter(connectorRow!);

    const realServer = await screen.findByText("真实服务");
    expect(screen.queryByText("已停用服务")).toBeNull();
    fireEvent.click(realServer);
    await waitFor(() => expect(onNavigateConnectors).toHaveBeenCalledTimes(1));
  });
});
