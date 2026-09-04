// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

const minimize = vi.fn();
const toggleMaximize = vi.fn();
const close = vi.fn();
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ minimize, toggleMaximize, close }),
}));

import { TitleBar } from "../TitleBar";

describe("TitleBar", () => {
  beforeEach(() => vi.clearAllMocks());

  it("渲染品牌与三个菜单", () => {
    render(<TitleBar onPlaceholder={() => {}} />);
    expect(screen.getByText("EchoAgent")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "编辑" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "窗口" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "帮助" })).toBeInTheDocument();
  });

  it("菜单触发器暴露状态，支持方向键导航与 Escape 焦点恢复", async () => {
    const user = userEvent.setup();
    render(<TitleBar onPlaceholder={() => {}} />);
    const trigger = screen.getByRole("button", { name: "帮助" });

    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    trigger.focus();
    await user.keyboard("{ArrowDown}");

    const menu = screen.getByRole("menu", { name: "帮助菜单" });
    const items = within(menu).getAllByRole("menuitem");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(items[0]).toHaveFocus();
    await user.keyboard("{End}");
    expect(items[items.length - 1]).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(items[0]).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(items[items.length - 1]).toHaveFocus();
    await user.keyboard("{Home}");
    expect(items[0]).toHaveFocus();
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("menu", { name: "帮助菜单" })).toBeNull();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
  });

  it("编辑菜单展开后点击复制调用 execCommand 并收起", () => {
    // 编辑菜单项现在接 document.execCommand（不再是 onPlaceholder）。
    // jsdom 没有 execCommand 实现，用 stub 替换。
    const onPlaceholder = vi.fn();
    const execMock = vi.fn().mockReturnValue(true);
    document.execCommand = execMock as unknown as typeof document.execCommand;
    render(<TitleBar onPlaceholder={onPlaceholder} />);
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.click(screen.getByText("复制"));
    expect(execMock).toHaveBeenCalledWith("copy");
    expect(onPlaceholder).not.toHaveBeenCalled();
    expect(screen.queryByText("粘贴")).not.toBeInTheDocument();
  });

  it("帮助菜单的'关于 EchoAgent'调用 onShowAbout", () => {
    const onShowAbout = vi.fn();
    render(<TitleBar onPlaceholder={() => {}} onShowAbout={onShowAbout} />);
    fireEvent.click(screen.getByRole("button", { name: "帮助" }));
    fireEvent.click(screen.getByText("关于 EchoAgent"));
    expect(onShowAbout).toHaveBeenCalled();
  });

  it("帮助菜单可手动检查更新", () => {
    const onCheckForUpdates = vi.fn();
    render(
      <TitleBar
        onPlaceholder={() => {}}
        onCheckForUpdates={onCheckForUpdates}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "帮助" }));
    fireEvent.click(screen.getByText("检查更新…"));
    expect(onCheckForUpdates).toHaveBeenCalledOnce();
  });

  it("窗口菜单的最小化调用窗口 API", () => {
    render(<TitleBar onPlaceholder={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "窗口" }));
    fireEvent.click(screen.getByText("最小化"));
    expect(minimize).toHaveBeenCalled();
  });

  it("窗口菜单的关闭调用窗口 close", () => {
    render(<TitleBar onPlaceholder={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "窗口" }));
    fireEvent.click(screen.getByText("关闭"));
    expect(close).toHaveBeenCalled();
  });

  it("点击 backdrop 收起菜单", () => {
    render(<TitleBar onPlaceholder={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.click(document.querySelector(".titlebar__backdrop") as Element);
    expect(screen.queryByText("复制")).not.toBeInTheDocument();
  });
});
