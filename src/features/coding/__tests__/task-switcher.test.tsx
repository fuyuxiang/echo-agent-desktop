import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { TaskSwitcher } from "../shell/TaskSwitcher";
import type { TaskSummary } from "../lib/types";

const stopped: TaskSummary = {
  id: "stopped",
  name: "订单管理",
  phase: "stopped",
  updatedAt: "2026-09-14T00:00:00Z",
};

const running: TaskSummary = {
  id: "running",
  name: "客户管理",
  phase: "implementing",
  updatedAt: "2026-09-14T00:00:01Z",
};

function setup(tasks = [stopped, running]) {
  const props = {
    tasks,
    activeId: stopped.id,
    onSelect: vi.fn(),
    onNew: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
  };
  render(<TaskSwitcher {...props} />);
  return props;
}

describe("TaskSwitcher", () => {
  it("为可恢复任务提供重命名和删除入口", async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.click(screen.getByRole("button", { name: "切换开发任务" }));
    await user.click(screen.getByRole("menuitem", { name: "管理任务：订单管理" }));
    const actions = screen.getByRole("menu", { name: "订单管理 任务操作" });

    await user.click(within(actions).getByRole("menuitem", { name: "重命名" }));
    expect(props.onRename).toHaveBeenCalledWith(stopped, expect.anything());

    await user.click(screen.getByRole("button", { name: "切换开发任务" }));
    await user.click(screen.getByRole("menuitem", { name: "管理任务：订单管理" }));
    await user.click(screen.getByRole("menuitem", { name: "删除任务" }));
    expect(props.onDelete).toHaveBeenCalledWith(stopped, expect.anything());
  });

  it("运行中任务必须先停止才能删除", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: "切换开发任务" }));
    await user.click(screen.getByRole("menuitem", { name: "管理任务：客户管理" }));
    const actions = screen.getByRole("menu", { name: "客户管理 任务操作" });

    expect(within(actions).getByRole("menuitem", { name: "执行中不可删除" })).toBeDisabled();
  });

  it("选择任务后关闭菜单", async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.click(screen.getByRole("button", { name: "切换开发任务" }));
    await user.click(screen.getByRole("menuitem", { name: "打开任务：客户管理，开发中" }));

    expect(props.onSelect).toHaveBeenCalledWith("running");
    expect(screen.queryByRole("menuitem", { name: "打开任务：订单管理，已停止" })).not.toBeInTheDocument();
  });

  it("支持从切换按钮用方向键进入并选择任务", async () => {
    const user = userEvent.setup();
    const props = setup();
    const toggle = screen.getByRole("button", { name: "切换开发任务" });
    toggle.focus();
    await user.keyboard("{ArrowDown}");
    const first = screen.getByRole("menuitem", { name: "打开任务：订单管理，已停止" });
    await waitFor(() => expect(first).toHaveFocus());
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(props.onSelect).toHaveBeenCalledWith("running");
  });
});
