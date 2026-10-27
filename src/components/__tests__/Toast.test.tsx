import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  it("信息类消息保留原文，错误类消息仍提供解释与详情", () => {
    const view = render(<Toast message="HTTP 403" kind="info" />);
    expect(screen.getByRole("status")).toHaveTextContent("HTTP 403");
    expect(screen.queryByText("查看详情")).toBeNull();
    view.rerender(<Toast message="HTTP 403" kind="error" />);
    expect(screen.getByRole("status")).toHaveTextContent("没有访问权限，请检查授权");
    expect(screen.getByText("查看详情")).toBeInTheDocument();
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

  it("默认解释错误，技术原因可以按需展开，并暂停消失", async () => {
    const onPause = vi.fn();
    render(<Toast message="读取失败：ENOENT: no such file or directory" onPause={onPause} />);
    expect(screen.getByRole("status")).toHaveTextContent("读取失败：找不到所需文件或内容，请刷新后重试");
    const details = screen.getByText("查看详情").closest("details")!;
    expect(details.open).toBe(false);
    fireEvent.click(screen.getByText("查看详情"));
    await waitFor(() => expect(onPause).toHaveBeenLastCalledWith(true));
    expect(details.open).toBe(true);
    expect(details).toHaveTextContent("ENOENT");
  });

  it("支持主动关闭，键盘焦点和鼠标悬停时保留提示", () => {
    const onPause = vi.fn(), onDismiss = vi.fn();
    render(<Toast message="文件已复制" onPause={onPause} onDismiss={onDismiss} />);
    fireEvent.mouseEnter(screen.getByRole("status"));
    expect(onPause).toHaveBeenLastCalledWith(true);
    fireEvent.mouseLeave(screen.getByRole("status"));
    expect(onPause).toHaveBeenLastCalledWith(false);
    fireEvent.focus(screen.getByRole("button", { name: "关闭提示" }));
    expect(onPause).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "关闭提示" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
