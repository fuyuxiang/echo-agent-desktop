import { createRef } from "react";
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/agent-client", () => ({
  commandsList: vi.fn().mockResolvedValue([
    { name: "commit", description: "提交变更" },
    { name: "review", description: "审查代码" },
  ]),
}));

import { SlashCommands, type SlashCommandsHandle } from "../SlashCommands";

describe("SlashCommands", () => {
  it("支持方向键选择并用 Enter 插入命令", async () => {
    const ref = createRef<SlashCommandsHandle>();
    const onPick = vi.fn();
    render(<SlashCommands ref={ref} text="/" cursor={1} onPick={onPick} />);
    await screen.findByText("/commit");

    const preventDefault = vi.fn();
    act(() => {
      expect(ref.current?.handleKeyDown({ key: "ArrowDown", preventDefault })).toBe(true);
    });
    act(() => {
      expect(ref.current?.handleKeyDown({ key: "Enter", preventDefault })).toBe(true);
    });

    expect(preventDefault).toHaveBeenCalledTimes(2);
    expect(onPick).toHaveBeenCalledWith("/review");
  });
});
