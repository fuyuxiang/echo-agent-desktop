import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ToolCallCard, ToolCallDetailBody } from "../ToolCallCard";
import type { ToolCallView } from "@/stores/session-store";

const base: ToolCallView = {
  toolCallId: "tc1",
  title: "Write C:\\Users\\example\\hello.txt",
  kind: "edit",
  status: "completed",
  content: [],
};

describe("ToolCallCard", () => {
  it("renders compact row and opens detail on click", () => {
    const onOpen = vi.fn();
    render(<ToolCallCard tc={base} onOpen={onOpen} />);
    // edit 属专用渲染器,kind 标签显示为「✏️ 文件编辑」。
    expect(screen.getByText("✏️ 文件编辑")).toBeInTheDocument();
    expect(screen.getByText(/hello\.txt/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    expect(onOpen).toHaveBeenCalledWith(base);
  });

  it("专用渲染器(send-message)显示图标 + 标签 + 摘要", () => {
    render(
      <ToolCallCard
        tc={{
          ...base,
          kind: "send_message",
          title: "通知",
          rawInput: { message: "你好,这是一条通知" },
        }}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText("💬 发送消息")).toBeInTheDocument();
    expect(screen.getByText("你好,这是一条通知")).toBeInTheDocument();
  });

  it("shows running status mark while in progress", () => {
    render(
      <ToolCallCard
        tc={{ ...base, status: "in_progress", title: "Execute notepad" }}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText("…")).toBeInTheDocument();
  });

  it("工具图片只渲染有界的内联栅格数据", () => {
    render(
      <ToolCallDetailBody
        tc={{
          ...base,
          content: [{ type: "image", mimeType: "image/png", data: "AAAA", uri: "https://tracker.invalid/pixel" }],
        }}
      />,
    );
    expect(screen.getByRole("img")).toHaveAttribute("src", "data:image/png;base64,AAAA");
    expect(screen.getByRole("img").getAttribute("src")).not.toContain("tracker.invalid");
  });

  it("拦截远程、SVG 或无效工具图片", () => {
    render(
      <ToolCallDetailBody
        tc={{
          ...base,
          content: [{ type: "image", mimeType: "image/svg+xml", data: "PHN2Zz4=", uri: "http://127.0.0.1/private" }],
        }}
      />,
    );
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent("已拦截不安全");
  });
});
