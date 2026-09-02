import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ThemeProvider } from "../ThemeProvider";
import { MessageItem } from "../MessageItem";
import type { ChatMessage } from "@/stores/session-store";

const { openLocalPath } = vi.hoisted(() => ({ openLocalPath: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/agent-client", () => ({ openLocalPath }));

const message: ChatMessage = {
  id: "u1",
  role: "user",
  parts: [{ kind: "text", text: "请优化这份方案" }],
  attachments: ["/tmp/AI数据集平台-数据回流方案.docx"],
  complete: true,
};

function renderMessage(onEditResend = vi.fn()) {
  return {
    onEditResend,
    ...render(
      <ThemeProvider>
        <MessageItem
          message={message}
          streaming={false}
          cwd="/tmp"
          onEditResend={onEditResend}
        />
      </ThemeProvider>,
    ),
  };
}

describe("MessageItem user attachments", () => {
  it("在用户气泡中展示文档名和类型", () => {
    renderMessage();
    expect(screen.getByText("AI数据集平台-数据回流方案.docx")).toBeInTheDocument();
    expect(screen.getByText("DOCX 文件")).toBeInTheDocument();
    expect(screen.getByText("请优化这份方案")).toBeInTheDocument();
  });

  it("点击文档卡片使用系统默认应用打开", async () => {
    renderMessage();
    fireEvent.click(screen.getByRole("button", { name: /打开附件 AI数据集平台/ }));
    await waitFor(() => {
      expect(openLocalPath).toHaveBeenCalledWith(
        "/tmp/AI数据集平台-数据回流方案.docx",
        "/tmp",
      );
    });
  });

  it("编辑重发同时传回文本和附件", () => {
    const onEditResend = vi.fn();
    renderMessage(onEditResend);
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    expect(onEditResend).toHaveBeenCalledWith(
      "请优化这份方案",
      ["/tmp/AI数据集平台-数据回流方案.docx"],
    );
  });
});
