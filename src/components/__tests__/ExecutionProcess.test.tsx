import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MessageItem } from "../MessageItem";
import { ThemeProvider } from "../ThemeProvider";
import type { ChatMessage, ToolCallView } from "@/stores/session-store";
import { useKnowledgeStore } from "@/stores/knowledge-store";

describe("assistant execution process", () => {
  const renderMessage = (onOpenTool?: (tool: ToolCallView) => void) => render(
    <ThemeProvider>
      <MessageItem
        message={message}
        streaming={false}
        onOpenTool={onOpenTool}
      />
    </ThemeProvider>,
  );

  const message: ChatMessage = {
    id: "assistant-1",
    role: "assistant",
    complete: true,
    startedAt: 1_000,
    completedAt: 9_000,
    parts: [
      { kind: "text", text: "我先检查代码。" },
      { kind: "thought", text: "需要从客户端交互状态入手。" },
      {
        kind: "tool_call",
        toolCall: {
          toolCallId: "tool-1",
          title: "Edit src/App.tsx",
          kind: "edit_file",
          status: "completed",
          content: [],
        },
      },
      { kind: "text", text: "最终修复结果" },
    ],
  };

  it("完成后默认收起过程并始终展示最终答复", () => {
    renderMessage();

    expect(screen.getByText("我先检查代码。")).toBeInTheDocument();
    expect(screen.getByText("最终修复结果")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /已完成执行过程/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByText("需要从客户端交互状态入手。")).toBeNull();
  });

  it("展开后可查看操作并打开右侧详情", () => {
    const onOpenTool = vi.fn();
    renderMessage(onOpenTool);

    fireEvent.click(screen.getByRole("button", { name: /已完成执行过程/ }));
    fireEvent.click(screen.getByRole("button", { name: /edit_file/i }));
    expect(onOpenTool).toHaveBeenCalledWith(
      expect.objectContaining({ toolCallId: "tool-1" }),
    );

    fireEvent.click(screen.getByText("思考过程"));
    expect(screen.getByText("需要从客户端交互状态入手。")).toBeInTheDocument();
  });

  it("运行时展开，完成后自动收起", async () => {
    const liveMessage: ChatMessage = {
      ...message,
      complete: false,
      completedAt: undefined,
      parts: message.parts.map((part) =>
        part.kind === "tool_call"
          ? { ...part, toolCall: { ...part.toolCall, status: "in_progress" as const } }
          : part,
      ),
    };
    const { rerender } = render(
      <ThemeProvider>
        <MessageItem message={liveMessage} streaming />
      </ThemeProvider>,
    );
    expect(screen.getByRole("button", { name: /正在修改文件/ }))
      .toHaveAttribute("aria-expanded", "true");

    rerender(
      <ThemeProvider>
        <MessageItem message={message} streaming={false} />
      </ThemeProvider>,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: /已完成执行过程/ }))
      .toHaveAttribute("aria-expanded", "false"));
  });

  it("没有回复文本的失败仍显示终止原因，不提供空复制", () => {
    render(
      <ThemeProvider>
        <MessageItem
          message={{
            id: "failed-empty",
            role: "assistant",
            parts: [],
            complete: true,
            stopReason: "error",
            agentResult: "provider disconnected",
          }}
          streaming={false}
        />
      </ThemeProvider>,
    );

    expect(screen.getByRole("button", { name: /执行未正常完成/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "复制纯文本" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /执行未正常完成/ }));
    expect(screen.getByRole("alert")).toHaveTextContent("provider disconnected");
  });

  it("在对应回复的执行过程中展示个人知识文件、行号和片段", () => {
    useKnowledgeStore.setState({
      turnTraces: {
        "session-kb": {
          "prompt-kb": {
            selectedSources: ["personal"],
            personal: {
              state: "used",
              resultCount: 1,
              sourceCount: 1,
              titles: ["差旅制度"],
              items: [{
                title: "差旅制度",
                path: "/notes/travel.md",
                sourceLabel: "本地笔记",
                snippet: "住宿标准为每晚 500 元。",
                startLine: 8,
                endLine: 10,
              }],
            },
          },
        },
      },
    });

    render(
      <ThemeProvider>
        <MessageItem
          message={{
            id: "assistant-kb",
            role: "assistant",
            promptId: "prompt-kb",
            parts: [{ kind: "text", text: "根据制度回答。" }],
            complete: true,
          }}
          streaming={false}
          sessionId="session-kb"
        />
      </ThemeProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /知识检索完成/ }));
    expect(screen.getByText("已向模型提供 1 个相关片段")).toBeInTheDocument();
    expect(screen.getByText("本地笔记 · 第 8–10 行")).toBeInTheDocument();
    expect(screen.getByText("住宿标准为每晚 500 元。")).toBeInTheDocument();
  });
});
