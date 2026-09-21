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

function ProgrammaticDialog({ children }: { children?: React.ReactNode }) {
  const ref = useModalFocus<HTMLDivElement>(true, () => {});
  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label="程序弹窗" tabIndex={-1}>
      {children}
    </div>
  );
}

describe("GlobalTooltip", () => {
  it("通过 body portal 显示 data-tip，不受父级层叠与裁剪影响", async () => {
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
    expect(screen.queryByRole("tooltip")).toBeNull();

    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent("更多操作");
    expect(tooltip.parentElement).toBe(document.body);
    expect(tooltip).toHaveStyle({ position: "fixed", zIndex: "var(--echo-layer-tooltip)" });
    expect(tooltip.style.width).toBe("");
    expect(trigger).toHaveAttribute("aria-describedby", tooltip.id);
  });

  it("视口下方空间不足时自动翻转，失去 hover 后清理提示", async () => {
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
    expect(await screen.findByRole("tooltip")).toHaveAttribute("data-placement", "top");

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
    expect(await screen.findByRole("tooltip")).toBeInTheDocument();

    view.rerender(
      <>
        <button type="button" data-tip="页面提示">页面按钮</button>
        <GlobalTooltip />
        <ProgrammaticDialog />
      </>,
    );

    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  });

  it("统一承接原生 title，延迟显示且不会叠加浏览器提示", async () => {
    render(
      <>
        <button type="button" aria-label="刷新" title="刷新" />
        <GlobalTooltip />
      </>,
    );
    const trigger = screen.getByRole("button", { name: "刷新" });

    fireEvent.pointerOver(trigger);

    expect(trigger).not.toHaveAttribute("title");
    expect(trigger).toHaveAttribute("data-global-tooltip-native");
    expect(screen.queryByRole("tooltip")).toBeNull();
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent("刷新");
    expect(trigger).not.toHaveAttribute("aria-describedby");

    fireEvent.pointerOut(trigger, { relatedTarget: document.body });
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(trigger).toHaveAttribute("title", "刷新");
    expect(trigger).not.toHaveAttribute("data-global-tooltip-native");
  });

  it("原生 title 是图标按钮唯一名称时，抑制期间保留可访问名称", async () => {
    render(
      <>
        <button type="button" title="打开设置" />
        <GlobalTooltip />
      </>,
    );
    const trigger = screen.getByRole("button", { name: "打开设置" });

    fireEvent.pointerOver(trigger);

    expect(trigger).toHaveAttribute("aria-label", "打开设置");
    expect(await screen.findByRole("tooltip")).toHaveTextContent("打开设置");
    fireEvent.pointerOut(trigger, { relatedTarget: document.body });
    expect(trigger).not.toHaveAttribute("aria-label");
    expect(trigger).toHaveAttribute("title", "打开设置");
  });

  it("触摸输入不弹出 hover 提示或移除原生语义", () => {
    render(
      <>
        <button type="button" aria-label="刷新" title="刷新" />
        <GlobalTooltip />
      </>,
    );
    const trigger = screen.getByRole("button", { name: "刷新" });

    fireEvent.pointerOver(trigger, { pointerType: "touch" });

    expect(trigger).toHaveAttribute("title", "刷新");
    expect(trigger).not.toHaveAttribute("data-global-tooltip-native");
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("弹窗内的提示保持可用，弹窗外的陈旧提示仍会被清理", async () => {
    render(
      <>
        <GlobalTooltip />
        <ProgrammaticDialog>
          <button type="button" aria-label="关闭" title="关闭" />
        </ProgrammaticDialog>
      </>,
    );
    const trigger = screen.getByRole("button", { name: "关闭" });

    fireEvent.pointerOver(trigger);

    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent("关闭");
    expect(tooltip).toHaveClass("global-tooltip--dialog");
  });

  it("悬停期间 React 更新 title 时同步文案并恢复最新值", async () => {
    const view = render(
      <>
        <button type="button" aria-label="初始状态" title="初始状态" />
        <GlobalTooltip />
      </>,
    );
    const trigger = screen.getByRole("button", { name: "初始状态" });
    fireEvent.pointerOver(trigger);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("初始状态");

    view.rerender(
      <>
        <button type="button" aria-label="最新状态" title="最新状态" />
        <GlobalTooltip />
      </>,
    );

    await waitFor(() => expect(screen.getByRole("tooltip")).toHaveTextContent("最新状态"));
    expect(trigger).not.toHaveAttribute("title");
    fireEvent.pointerOut(trigger, { relatedTarget: document.body });
    expect(trigger).toHaveAttribute("title", "最新状态");
  });
});
