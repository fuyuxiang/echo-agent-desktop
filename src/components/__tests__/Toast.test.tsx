import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Toast } from "../Toast";

describe("Toast", () => {
  it("message 为 null 时不渲染", () => {
    const { container } = render(<Toast message={null} />);
    expect(container).toBeEmptyDOMElement();
  });
  it("渲染消息文本", () => {
    render(<Toast message="搜索 即将上线" />);
    expect(screen.getByText("搜索 即将上线")).toBeInTheDocument();
  });

  it("支持归档后的撤销与管理动作", () => {
    const onDismiss = vi.fn();
    const onUndo = vi.fn();
    render(
      <Toast
        message="已归档，会话已从侧边栏收起"
        actions={[{ label: "撤销", onClick: onUndo }]}
        onDismiss={onDismiss}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onUndo).toHaveBeenCalledTimes(1);
  });
});
