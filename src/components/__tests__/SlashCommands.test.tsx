import { createRef } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/agent-client", () => ({
  commandsList: vi.fn(),
}));

import { commandsList } from "@/lib/agent-client";
import { SlashCommands, type SlashCommandsHandle } from "../SlashCommands";

const commandsListMock = vi.mocked(commandsList);

describe("SlashCommands", () => {
  beforeEach(() => {
    commandsListMock.mockReset();
    commandsListMock.mockResolvedValue([
      { name: "commit", description: "提交变更", argumentHint: "message", source: "skill:project" },
      { name: "acme:review", description: "审查代码", source: "plugin:acme" },
    ]);
  });

  it("使用当前会话和工作目录加载命令并渲染完整元数据", async () => {
    render(
      <SlashCommands
        text="/com"
        cursor={4}
        sessionId="session-1"
        cwd="/repo"
        onPick={vi.fn()}
      />,
    );

    expect(await screen.findByText("/commit")).toBeInTheDocument();
    expect(commandsListMock).toHaveBeenCalledWith("session-1", "/repo");
    expect(screen.getByText("message")).toBeInTheDocument();
    expect(screen.getByText("技能 · project")).toBeInTheDocument();
  });

  it("支持选择带命名空间的插件命令", async () => {
    const onPick = vi.fn();
    render(<SlashCommands text="/acme:" cursor={6} onPick={onPick} />);

    fireEvent.click(await screen.findByText("/acme:review"));
    expect(onPick).toHaveBeenCalledWith("/acme:review");
  });

  it("键盘选择严格限制在已渲染的 12 条内", async () => {
    commandsListMock.mockResolvedValue(
      Array.from({ length: 15 }, (_, i) => ({ name: `cmd${i}`, description: `command ${i}` })),
    );
    const ref = createRef<SlashCommandsHandle>();
    const onPick = vi.fn();
    render(<SlashCommands ref={ref} text="/cmd" cursor={4} onPick={onPick} />);

    await screen.findByText("/cmd0");
    expect(screen.queryByText("/cmd12")).not.toBeInTheDocument();

    const preventDefault = vi.fn();
    act(() => {
      expect(ref.current?.handleKeyDown({ key: "ArrowUp", preventDefault })).toBe(true);
    });
    act(() => {
      expect(ref.current?.handleKeyDown({ key: "Enter", preventDefault })).toBe(true);
    });

    expect(onPick).toHaveBeenCalledWith("/cmd11");
  });

  it("运行时目录更新后重新拉取", async () => {
    const { rerender } = render(
      <SlashCommands text="/com" cursor={4} refreshKey={0} onPick={vi.fn()} />,
    );
    await screen.findByText("/commit");

    rerender(<SlashCommands text="/com" cursor={4} refreshKey={1} onPick={vi.fn()} />);
    await waitFor(() => expect(commandsListMock).toHaveBeenCalledTimes(2));
  });

  it("加载失败时保留桌面命令并支持重试", async () => {
    commandsListMock.mockRejectedValueOnce(new Error("offline"));
    const { rerender } = render(<SlashCommands text="/" cursor={1} onPick={vi.fn()} />);

    expect(await screen.findByText("/help")).toBeInTheDocument();
    expect(screen.getByText(/offline/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(commandsListMock).toHaveBeenCalledTimes(2));
    rerender(<SlashCommands text="/com" cursor={4} onPick={vi.fn()} />);
    expect(await screen.findByText("/commit")).toBeInTheDocument();
  });

  it("Escape 关闭菜单而不发送命令", async () => {
    const ref = createRef<SlashCommandsHandle>();
    render(<SlashCommands ref={ref} text="/com" cursor={4} onPick={vi.fn()} />);
    await screen.findByText("/commit");

    const preventDefault = vi.fn();
    act(() => {
      expect(ref.current?.handleKeyDown({ key: "Escape", preventDefault })).toBe(true);
    });

    expect(preventDefault).toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});
