import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
import { agentsList } from "@/lib/agent-client";

describe("InputAddMenu", () => {
  it("不展示内置模式入口", async () => {
    render(<InputAddMenu onPickFiles={vi.fn()} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "添加" }));
    });
    expect(screen.queryByText("模式")).toBeNull();
  });

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

  it("支持方向键进入子菜单，Escape 关闭并恢复触发器焦点", async () => {
    vi.mocked(agentsList).mockResolvedValueOnce([
      {
        name: "代码专家",
        path: "/agents/code.md",
        description: "审查代码",
        scope: "user",
        raw: "# 代码专家",
      },
    ]);
    render(<InputAddMenu onPickFiles={vi.fn()} onSelectExpert={vi.fn()} />);

    const trigger = screen.getByRole("button", { name: "添加" });
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menu", { name: "添加内容" })).toBeInTheDocument();

    const addFiles = screen.getByRole("menuitem", { name: "点击选择文件" });
    expect(addFiles).toHaveFocus();
    fireEvent.keyDown(addFiles, { key: "ArrowDown" });
    const experts = screen.getByRole("menuitem", { name: "专家" });
    expect(experts).toHaveFocus();
    fireEvent.keyDown(experts, { key: "ArrowRight" });

    expect(await screen.findByRole("menu", { name: "专家子菜单" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("menuitem", { name: /代码专家/ })).toHaveFocus());

    fireEvent.keyDown(document, { key: "Escape" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
  });

  it("加载失败时不误报为空列表，并可就地重试", async () => {
    vi.mocked(agentsList)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce([
        {
          name: "恢复后的专家",
          path: "/agents/recovered.md",
          description: "可用",
          scope: "user",
          raw: "# 恢复后的专家",
        },
      ]);
    render(<InputAddMenu onPickFiles={vi.fn()} onSelectExpert={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    fireEvent.mouseEnter(screen.getByRole("menuitem", { name: "专家" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("专家加载失败");
    expect(screen.queryByText("暂无已安装专家")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "重试" }));

    expect(await screen.findByRole("menuitem", { name: /恢复后的专家/ })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
