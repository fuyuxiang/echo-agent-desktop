import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  FileTreeContextMenu,
  type ContextMenuItem,
} from "@/components/workspace-panel/FileTreeContextMenu";

function makeItems(): ContextMenuItem[] {
  return [
    { id: "open", label: "打开", onSelect: vi.fn() },
    { id: "rename", label: "重命名", shortcut: "F2", onSelect: vi.fn() },
    {
      id: "delete",
      label: "删除",
      danger: true,
      dividerBefore: true,
      onSelect: vi.fn(),
    },
    {
      id: "paste",
      label: "粘贴",
      disabled: true,
      onSelect: vi.fn(),
    },
  ];
}

describe("FileTreeContextMenu", () => {
  it("渲染所有 item 和 shortcut", () => {
    render(<FileTreeContextMenu x={10} y={10} items={makeItems()} onClose={vi.fn()} />);
    expect(screen.getByRole("menuitem", { name: /打开/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /重命名/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /删除/ })).toBeInTheDocument();
    expect(screen.getByText("F2")).toBeInTheDocument();
  });

  it("danger 项带 --danger class", () => {
    render(<FileTreeContextMenu x={10} y={10} items={makeItems()} onClose={vi.fn()} />);
    const del = screen.getByRole("menuitem", { name: /删除/ });
    expect(del.className).toContain("context-menu__item--danger");
  });

  it("disabled 项不可点击", async () => {
    const items = makeItems();
    render(<FileTreeContextMenu x={10} y={10} items={items} onClose={vi.fn()} />);
    const paste = screen.getByRole("menuitem", { name: /粘贴/ });
    expect(paste).toBeDisabled();
    expect(paste.className).toContain("context-menu__item--disabled");
  });

  it("dividerBefore 在对应 item 前插入 divider", () => {
    const { baseElement } = render(
      <FileTreeContextMenu x={10} y={10} items={makeItems()} onClose={vi.fn()} />,
    );
    const dividers = baseElement.querySelectorAll(".context-menu__divider");
    expect(dividers.length).toBeGreaterThanOrEqual(1);
  });

  it("Escape 触发 onClose", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<FileTreeContextMenu x={10} y={10} items={makeItems()} onClose={onClose} />);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("外点 pointerdown 触发 onClose", () => {
    const onClose = vi.fn();
    render(<FileTreeContextMenu x={10} y={10} items={makeItems()} onClose={onClose} />);
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalled();
  });

  it("点击 item 调用 onSelect 并关闭菜单", async () => {
    const items = makeItems();
    const onClose = vi.fn();
    render(<FileTreeContextMenu x={10} y={10} items={items} onClose={onClose} />);
    const openItem = screen.getByRole("menuitem", { name: /打开/ });
    fireEvent.click(openItem);
    await waitFor(() => expect(items[0]).toHaveProperty("onSelect"));
    const first = items[0] as Extract<ContextMenuItem, { onSelect: unknown }>;
    expect(first.onSelect).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalled();
  });

  it("onSelect 抛错走 onError 而不是 onClose", async () => {
    const items: ContextMenuItem[] = [
      { id: "boom", label: "爆炸", onSelect: vi.fn().mockRejectedValue(new Error("nope")) },
    ];
    const onError = vi.fn();
    const onClose = vi.fn();
    render(
      <FileTreeContextMenu
        x={10}
        y={10}
        items={items}
        onClose={onClose}
        onError={onError}
      />,
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /爆炸/ }));
    await waitFor(() => expect(onError).toHaveBeenCalled());
  });
});
