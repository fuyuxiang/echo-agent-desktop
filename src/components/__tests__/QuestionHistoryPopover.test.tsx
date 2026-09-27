import { createRef } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@/stores/session-store";
import { buildQuestionHistory, QuestionHistoryPopover } from "../QuestionHistoryPopover";

describe("QuestionHistoryPopover", () => {
  it("按最新在前列出可见提问，并处理隐藏上下文和纯附件消息", () => {
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", complete: true, parts: [{ kind: "text", text: "先看项目结构\n<!--EXPERT_PERSONA_BEGIN-->内部提示<!--EXPERT_PERSONA_END-->" }] },
      { id: "a1", role: "assistant", complete: true, parts: [{ kind: "text", text: "完成" }] },
      { id: "u2", role: "user", complete: true, parts: [], attachments: ["C:\\work\\design.png"] },
    ];

    expect(buildQuestionHistory(messages)).toEqual([
      { id: "u2", order: 2, text: "附件：design.png", preview: "附件：design.png" },
      { id: "u1", order: 1, text: "先看项目结构", preview: "先看项目结构" },
    ]);
  });

  it("筛选提问、选择目标并用 Escape 关闭", () => {
    const triggerRef = createRef<HTMLButtonElement>();
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const onFind = vi.fn();
    render(<>
      <button ref={triggerRef}>打开历史提问</button>
      <QuestionHistoryPopover
        items={[
          { id: "u2", order: 2, text: "检查构建结果", preview: "检查构建结果" },
          { id: "u1", order: 1, text: "分析项目结构", preview: "分析项目结构" },
        ]}
        triggerRef={triggerRef}
        onSelect={onSelect}
        onClose={onClose}
        onFind={onFind}
      />
    </>);

    const dialog = screen.getByRole("dialog", { name: "历史提问" });
    const search = within(dialog).getByRole("searchbox", { name: "筛选历史提问" });
    fireEvent.change(search, { target: { value: "构建" } });
    const result = within(dialog).getByRole("button", { name: /检查构建结果/ });
    expect(result).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /分析项目结构/ })).toBeNull();
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(result).toHaveFocus();
    fireEvent.click(result);
    expect(onSelect).toHaveBeenCalledWith("u2");
    fireEvent.keyDown(document, { key: "f", ctrlKey: true });
    expect(onFind).toHaveBeenCalledOnce();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    expect(triggerRef.current).toHaveFocus();
  });
});
