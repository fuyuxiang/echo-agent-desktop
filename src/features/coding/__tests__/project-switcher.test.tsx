import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ProjectSwitcher } from "../shell/ProjectSwitcher";

function setup() {
  const props = {
    projects: [{ cwd: "/repo/current" }, { cwd: "/repo/other" }],
    activeCwd: "/repo/current",
    dirtyCount: 2,
    onSelect: vi.fn(),
    onRemove: vi.fn(),
    onOpenFolder: vi.fn(),
  };
  render(<ProjectSwitcher {...props} />);
  return props;
}

describe("ProjectSwitcher", () => {
  it("把当前项目和最近项目呈现为切换器，而不是并列标签", async () => {
    const user = userEvent.setup();
    const props = setup();

    const toggle = screen.getByRole("button", { name: "切换项目" });
    expect(toggle).toHaveTextContent("current");
    expect(toggle).toHaveTextContent("2");

    await user.click(toggle);
    expect(screen.getByRole("menu", { name: "项目列表" })).toBeInTheDocument();
    expect(screen.getByText("/repo/current")).toBeInTheDocument();
    expect(screen.getByText("/repo/other")).toBeInTheDocument();

    await user.click(screen.getByRole("menuitem", { name: "切换到项目 other" }));
    expect(props.onSelect).toHaveBeenCalledWith("/repo/other");
  });

  it("可移除最近项目或打开其他文件夹", async () => {
    const user = userEvent.setup();
    const props = setup();

    await user.click(screen.getByRole("button", { name: "切换项目" }));
    await user.click(screen.getByRole("menuitem", { name: "从最近项目移除 other" }));
    expect(props.onRemove).toHaveBeenCalledWith("/repo/other");

    await user.click(screen.getByRole("button", { name: "切换项目" }));
    await user.click(screen.getByRole("menuitem", { name: "打开其他文件夹…" }));
    expect(props.onOpenFolder).toHaveBeenCalledTimes(1);
  });

  it("支持通过方向键进入菜单并用 Escape 返回", async () => {
    const user = userEvent.setup();
    setup();
    const toggle = screen.getByRole("button", { name: "切换项目" });

    toggle.focus();
    await user.keyboard("{ArrowDown}");
    expect(await screen.findByRole("menu", { name: "项目列表" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu", { name: "项目列表" })).not.toBeInTheDocument();
    expect(toggle).toHaveFocus();
  });
});
