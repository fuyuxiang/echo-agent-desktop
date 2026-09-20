import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GlobalTooltip } from "../GlobalTooltip";
import { useModalFocus } from "@/lib/use-modal-focus";

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

function ProgrammaticDialog() {
  const ref = useModalFocus<HTMLDivElement>(true, () => {});
  return <div ref={ref} role="dialog" aria-modal="true" aria-label="程序弹窗" tabIndex={-1} />;
}

describe("GlobalTooltip", () => {
  it("通过 body portal 显示 data-tip，不受父级层叠与裁剪影响", () => {
    render(
      <>
        <div data-testid="clipping-layer" style={{ overflow: "hidden" }}>
          <button type="button" data-tip="更多操作">操作</button>
        </div>
        <GlobalTooltip />
      </>,
    );
    const trigger = screen.getByRole("button", { name: "操作" });
    trigger.getBoundingClientRect = () => rect(100, 20);

    fireEvent.pointerOver(trigger);

    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent("更多操作");
    expect(tooltip.parentElement).toBe(document.body);
    expect(tooltip).toHaveStyle({ position: "fixed", zIndex: "var(--echo-layer-tooltip)" });
    expect(trigger).toHaveAttribute("aria-describedby", tooltip.id);
  });

  it("视口下方空间不足时自动翻转，失去 hover 后清理提示", () => {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 100 });
    render(
      <>
        <button type="button" data-tip="完整路径">/workspace/project</button>
        <GlobalTooltip />
      </>,
    );
    const trigger = screen.getByRole("button", { name: "/workspace/project" });
    trigger.getBoundingClientRect = () => rect(20, 70, 120, 24);

    fireEvent.pointerOver(trigger);
    expect(screen.getByRole("tooltip")).toHaveAttribute("data-placement", "top");

    fireEvent.pointerOut(trigger, { relatedTarget: document.body });
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(trigger).not.toHaveAttribute("aria-describedby");
  });

  it("键盘聚焦可见，激活控件时立即关闭提示", () => {
    render(
      <>
        <button type="button" data-tip="切换工作目录">工作目录</button>
        <GlobalTooltip />
      </>,
    );
    const trigger = screen.getByRole("button", { name: "工作目录" });

    fireEvent.focusIn(trigger);
    expect(screen.getByRole("tooltip")).toHaveTextContent("切换工作目录");

    fireEvent.click(trigger);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("方向键打开菜单前会清理键盘 tooltip", () => {
    render(
      <>
        <button type="button" data-tip="更多操作">更多</button>
        <GlobalTooltip />
      </>,
    );
    const trigger = screen.getByRole("button", { name: "更多" });

    fireEvent.focusIn(trigger);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("程序化弹窗出现时也会移除已显示的页面 tooltip", async () => {
    const view = render(
      <>
        <button type="button" data-tip="页面提示">页面按钮</button>
        <GlobalTooltip />
      </>,
    );
    const trigger = screen.getByRole("button", { name: "页面按钮" });
    fireEvent.pointerOver(trigger);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();

    view.rerender(
      <>
        <button type="button" data-tip="页面提示">页面按钮</button>
        <GlobalTooltip />
        <ProgrammaticDialog />
      </>,
    );

    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  });
});
