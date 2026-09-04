import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("@/lib/agent-client", () => ({
  filesystemPickDirectory: vi.fn().mockResolvedValue(null),
}));

import { WorkspacePicker } from "../WorkspacePicker";

describe("WorkspacePicker", () => {
  it("使用有语义菜单支持方向键、Escape 和焦点恢复", () => {
    render(
      <WorkspacePicker
        cwd="/work/one"
        workspaces={[
          { cwd: "/work/one", sessionCount: 1 },
          { cwd: "/work/two", sessionCount: 2 },
        ]}
        onSelectWorkspace={vi.fn()}
      />,
    );

    const trigger = screen.getByRole("button", { name: /work\/one/ });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menu", { name: "选择工作空间" })).toBeInTheDocument();
    const current = screen.getByRole("menuitemradio", { name: /work\/one/ });
    const next = screen.getByRole("menuitemradio", { name: /work\/two/ });
    expect(current).toHaveFocus();
    fireEvent.keyDown(current, { key: "ArrowDown" });
    expect(next).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
  });
});
