import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { TopbarActions } from "../TopbarActions";
import {
  agentSetSessionArchived,
  agentSetSessionPinned,
  exportTextFile,
} from "@/lib/agent-client";

vi.mock("@/lib/agent-client", () => ({
  agentSetSessionArchived: vi.fn(),
  agentSetSessionPinned: vi.fn(),
  exportTextFile: vi.fn(),
}));

function rect(left: number, top: number, width = 32, height = 32): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  };
}

function setViewport(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
}

describe("TopbarActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setViewport(1000, 600);
    vi.mocked(agentSetSessionArchived).mockResolvedValue(true);
    vi.mocked(agentSetSessionPinned).mockResolvedValue(true);
    vi.mocked(exportTextFile).mockResolvedValue(null);
  });

  it("通过 body portal 以 fixed 浮层渲染，不受顶栏层叠上下文和裁剪影响", () => {
    render(<TopbarActions sessionId="session-1" title="测试会话" />);
    const trigger = screen.getByRole("button", { name: "更多操作" });
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue(rect(400, 20));

    fireEvent.click(trigger);

    const menu = screen.getByRole("menu", { name: "当前会话操作" });
    expect(menu.parentElement).toBe(document.body);
    expect(menu.closest(".topbar-actions")).toBeNull();
    expect(menu).toHaveStyle({ position: "fixed", zIndex: "1200" });
    expect(menu).toHaveAttribute("data-placement", "bottom");
    expect(within(menu).getByRole("menuitem", { name: "归档会话" })).toBeVisible();
  });

  it("视口底部空间不足时向上展开并保持在可视区域", () => {
    render(<TopbarActions sessionId="session-1" title="测试会话" />);
    const trigger = screen.getByRole("button", { name: "更多操作" });
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue(rect(960, 560));

    fireEvent.click(trigger);

    const menu = screen.getByRole("menu");
    expect(menu).toHaveAttribute("data-placement", "top");
    expect(Number.parseFloat(menu.style.top)).toBeLessThan(560);
    expect(Number.parseFloat(menu.style.left)).toBeGreaterThanOrEqual(8);
  });

  it("点击归档会调用后端，更新目录并通知 App 退出当前会话", async () => {
    const onToast = vi.fn();
    const onSessionsChanged = vi.fn();
    const onArchived = vi.fn();
    render(
      <TopbarActions
        sessionId="session-1"
        title="测试会话"
        onToast={onToast}
        onSessionsChanged={onSessionsChanged}
        onArchived={onArchived}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "归档会话" }));

    expect(agentSetSessionArchived).toHaveBeenCalledTimes(1);
    expect(agentSetSessionArchived).toHaveBeenCalledWith("session-1", true);
    await waitFor(() => {
      expect(onSessionsChanged).toHaveBeenCalledWith({ archived: true });
      expect(onArchived).toHaveBeenCalledWith(true);
    });
    expect(onToast).toHaveBeenCalledWith("已归档（可在侧栏筛选中找回）");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("归档失败时不改前端状态，并给出可读的错误提示", async () => {
    vi.mocked(agentSetSessionArchived).mockRejectedValueOnce(new Error("磁盘不可写"));
    const onToast = vi.fn();
    const onSessionsChanged = vi.fn();
    const onArchived = vi.fn();
    render(
      <TopbarActions
        sessionId="session-1"
        title="测试会话"
        onToast={onToast}
        onSessionsChanged={onSessionsChanged}
        onArchived={onArchived}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "归档会话" }));

    await waitFor(() => expect(onToast).toHaveBeenCalledWith("归档失败：磁盘不可写"));
    expect(onSessionsChanged).not.toHaveBeenCalled();
    expect(onArchived).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "更多操作" })).toBeEnabled();
  });

  it("支持方向键、Home/End 和 Escape，关闭后恢复触发按钮焦点", async () => {
    render(<TopbarActions sessionId="session-1" title="测试会话" />);
    const trigger = screen.getByRole("button", { name: "更多操作" });
    trigger.focus();

    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    const menu = screen.getByRole("menu");
    const items = within(menu).getAllByRole("menuitem");
    expect(items[items.length - 1]).toHaveFocus();

    fireEvent.keyDown(menu, { key: "Home" });
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(items[items.length - 1]).toHaveFocus();
    fireEvent.keyDown(menu, { key: "Escape" });

    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
