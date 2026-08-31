import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ModelSelector } from "../ModelSelector";

describe("ModelSelector", () => {
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
});
