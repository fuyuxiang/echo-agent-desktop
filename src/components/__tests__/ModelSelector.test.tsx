import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ModelSelector } from "../ModelSelector";

describe("ModelSelector", () => {
  it("菜单通过 body portal 渲染并在上方空间不足时向下翻转", () => {
    render(
      <div data-testid="clipping-card" style={{ overflow: "hidden" }}>
        <ModelSelector
          modelId="model-a"
          models={[{ id: "model-a", label: "模型 A" }]}
          onModelChange={vi.fn()}
        />
      </div>,
    );
    const trigger = screen.getByRole("button", { name: "模型 A" });
    trigger.getBoundingClientRect = () => ({
      x: 12,
      y: 10,
      top: 10,
      right: 132,
      bottom: 42,
      left: 12,
      width: 120,
      height: 32,
      toJSON: () => ({}),
    });

    fireEvent.click(trigger);

    const menu = screen.getByRole("listbox", { name: "选择模型" });
    expect(menu.parentElement).toBe(document.body);
    expect(menu).toHaveStyle({ position: "fixed", zIndex: "var(--echo-layer-popover)" });
    expect(menu).toHaveAttribute("data-placement", "bottom");
  });

  it("弹窗内的 portal 菜单可显式使用弹窗局部层", () => {
    render(
      <ModelSelector
        modelId="model-a"
        models={[{ id: "model-a", label: "模型 A" }]}
        onModelChange={vi.fn()}
        menuZIndex="var(--echo-layer-dialog-popover)"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "模型 A" }));
    expect(screen.getByRole("listbox", { name: "选择模型" })).toHaveStyle({
      zIndex: "var(--echo-layer-dialog-popover)",
    });
  });

  it("加载模型信息时不显示未选择，恢复后显示实际模型", () => {
    const onModelChange = vi.fn();
    const { rerender } = render(<ModelSelector models={[{ id: "model-a", label: "模型 A" }]} modelLoading onModelChange={onModelChange} />);
    expect(screen.getByRole("button", { name: "正在同步模型…" })).toBeDisabled();
    expect(screen.queryByText("请选择模型")).toBeNull();
    rerender(<ModelSelector models={[{ id: "model-a", label: "模型 A" }]} modelId="model-a" onModelChange={onModelChange} />);
    expect(screen.getByRole("button", { name: "模型 A" })).toBeEnabled();
  });

  it("空配置时显示未配置模型，不显示 Runtime 默认 id", () => {
    render(
      <ModelSelector
        modelId="runtime-default"
        models={[]}
        onModelChange={vi.fn()}
      />,
    );

    const trigger = screen.getByRole("button", { name: "未配置模型" });
    expect(trigger).toBeDisabled();
    expect(screen.queryByText("runtime-default")).toBeNull();
  });

  it("有配置时显示并可切换模型", () => {
    const onModelChange = vi.fn();
    render(
      <ModelSelector
        modelId="glm-5"
        models={[
          { id: "glm-5", label: "GLM 5" },
          { id: "deepseek-chat", label: "DeepSeek Chat" },
        ]}
        onModelChange={onModelChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "GLM 5" }));
    fireEvent.click(screen.getByRole("option", { name: /DeepSeek Chat/ }));
    expect(onModelChange).toHaveBeenCalledWith("deepseek-chat");
  });

  it("选择模型时不触发父级的设置引导", () => {
    const onParentClick = vi.fn();
    const onModelChange = vi.fn();
    render(
      <div onClick={onParentClick}>
        <ModelSelector
          models={[{ id: "MiniMax-M3", label: "MiniMax M3" }]}
          onModelChange={onModelChange}
        />
      </div>,
    );

    fireEvent.click(screen.getByRole("button", { name: "请选择模型" }));
    fireEvent.click(screen.getByRole("option", { name: /MiniMax M3/ }));

    expect(onModelChange).toHaveBeenCalledWith("MiniMax-M3");
    expect(onParentClick).not.toHaveBeenCalled();
  });

  it("支持方向键导航、Escape 关闭与焦点恢复", () => {
    render(
      <ModelSelector
        modelId="glm-5"
        models={[
          { id: "glm-5", label: "GLM 5" },
          { id: "deepseek-chat", label: "DeepSeek Chat" },
        ]}
        onModelChange={vi.fn()}
      />,
    );
    const trigger = screen.getByRole("button", { name: "GLM 5" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const first = screen.getByRole("option", { name: /GLM 5/ });
    const second = screen.getByRole("option", { name: /DeepSeek Chat/ });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(second).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
  });

  it("同一页多个模型选择器具有独立可访问标识", () => {
    render(
      <>
        <ModelSelector
          ariaLabel="选择项目默认模型"
          modelId="model-a"
          models={[{ id: "model-a", label: "模型 A" }]}
          onModelChange={vi.fn()}
        />
        <ModelSelector
          ariaLabel="选择项目对话模型"
          modelId="model-a"
          models={[{ id: "model-a", label: "模型 A" }]}
          onModelChange={vi.fn()}
        />
      </>,
    );

    const first = screen.getByRole("button", { name: /选择项目默认模型/ });
    const second = screen.getByRole("button", { name: /选择项目对话模型/ });
    fireEvent.click(first);
    const firstControls = first.getAttribute("aria-controls");
    fireEvent.click(second);
    const secondControls = second.getAttribute("aria-controls");

    expect(firstControls).toBeTruthy();
    expect(secondControls).toBeTruthy();
    expect(firstControls).not.toBe(secondControls);
  });
});
