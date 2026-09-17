import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { ThemeProvider } from "../ThemeProvider";
import { MessageItem } from "../MessageItem";
import type { ChatMessage } from "@/stores/session-store";

function renderMessage(message: ChatMessage, findQuery: string) {
  return render(
    <ThemeProvider>
      <MessageItem message={message} streaming={false} findQuery={findQuery} />
    </ThemeProvider>,
  );
}

describe("MessageItem find highlighting", () => {
  it("只高亮用户可见正文，不暴露或计入注入上下文", () => {
    const message = {
      id: "user-find",
      role: "user",
      complete: true,
      parts: [{
        kind: "text",
        text: "<!--EXPERT_PERSONA_BEGIN-->内部关键词<!--EXPERT_PERSONA_END-->\n关键词正文",
      }],
    } as ChatMessage;

    const { container } = renderMessage(message, "关键词");
    expect(container.querySelectorAll(".find-hit")).toHaveLength(1);
    expect(container.querySelector(".find-hit")).toHaveTextContent("关键词");
    expect(container).not.toHaveTextContent("内部关键词");
  });

  it("多个 assistant Markdown 回复段都生成可连续收集的命中", () => {
    const message = {
      id: "assistant-find",
      role: "assistant",
      complete: true,
      parts: [
        { kind: "text", text: "第一处关键词与第二处关键词" },
        { kind: "text", text: "第三处 **关键词**" },
      ],
    } as ChatMessage;

    const { container } = renderMessage(message, "关键词");
    expect(container.querySelectorAll(".find-hit")).toHaveLength(3);
  });
});
