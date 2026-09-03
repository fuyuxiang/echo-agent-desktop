import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ThemeProvider } from "../ThemeProvider";
import { MessageItem } from "../MessageItem";
import type { ChatMessage } from "@/stores/session-store";

const { openLocalPath, attachmentThumbnail } = vi.hoisted(() => ({
  openLocalPath: vi.fn().mockResolvedValue(undefined),
  attachmentThumbnail: vi.fn().mockResolvedValue("jpeg-base64"),
}));
vi.mock("@/lib/agent-client", () => ({ openLocalPath, attachmentThumbnail }));

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

  it("图片附件懒加载原生缩略图并保留点击打开", async () => {
    const imageMessage: ChatMessage = {
      ...message,
      attachments: ["/tmp/screenshot.PNG"],
    };
    render(
      <ThemeProvider>
        <MessageItem message={imageMessage} streaming={false} cwd="/tmp" />
      </ThemeProvider>,
    );

    expect(screen.getByText("PNG 图片")).toBeInTheDocument();
    await waitFor(() => {
      expect(attachmentThumbnail).toHaveBeenCalledWith("/tmp/screenshot.PNG");
      expect(document.querySelector(".msg__attachment-thumbnail"))
        .toHaveAttribute("src", "data:image/jpeg;base64,jpeg-base64");
    });

    fireEvent.click(screen.getByRole("button", { name: "打开附件 screenshot.PNG" }));
    await waitFor(() => {
      expect(openLocalPath).toHaveBeenCalledWith("/tmp/screenshot.PNG", "/tmp");
    });
  });

  it("缩略图生成失败时降级为图片图标，不影响附件卡片", async () => {
    attachmentThumbnail.mockRejectedValueOnce(new Error("missing"));
    const imageMessage: ChatMessage = {
      ...message,
      attachments: ["/tmp/missing.webp"],
    };
    render(
      <ThemeProvider>
        <MessageItem message={imageMessage} streaming={false} cwd="/tmp" />
      </ThemeProvider>,
    );

    await waitFor(() => expect(attachmentThumbnail).toHaveBeenCalledWith("/tmp/missing.webp"));
    expect(screen.getByText("WEBP 图片")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开附件 missing.webp" })).toBeEnabled();
    expect(document.querySelector(".msg__attachment-thumbnail")).toBeNull();
  });
});
