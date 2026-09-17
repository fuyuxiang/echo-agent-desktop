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

    expect(screen.queryByText("我先检查代码。")).toBeNull();
    expect(screen.getByText("最终修复结果")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /已完成执行过程/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByText("需要从客户端交互状态入手。")).toBeNull();
  });

  it("将模型混在同一文本块的思考折叠，只直接显示答案", () => {
    render(
      <ThemeProvider>
        <MessageItem
          message={{
            id: "assistant-tagged-thinking",
            role: "assistant",
            complete: true,
            parts: [{
              kind: "text",
              text: "<analysis>The user asks about a timeout.</analysis>\n\n超时通常表示某一层的等待预算用完了。",
              streamId: "generation-1",
            }],
          }}
          streaming={false}
        />
      </ThemeProvider>,
    );

    expect(screen.getByText("超时通常表示某一层的等待预算用完了。")).toBeInTheDocument();
    expect(screen.queryByText("The user asks about a timeout.")).toBeNull();
    const process = screen.getByRole("button", { name: /已完成思考/ });
    expect(process).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(process);
    fireEvent.click(screen.getByText("深度思考"));
    expect(screen.getByText("The user asks about a timeout.")).toBeInTheDocument();
    expect(screen.queryByText(/<analysis>/)).toBeNull();
  });

  it("展开后可查看操作并打开右侧详情", () => {
    const onOpenTool = vi.fn();
    renderMessage(onOpenTool);

    fireEvent.click(screen.getByRole("button", { name: /已完成执行过程/ }));
    fireEvent.click(screen.getByRole("button", { name: /edit_file/i }));
    expect(onOpenTool).toHaveBeenCalledWith(
      expect.objectContaining({ toolCallId: "tool-1" }),
    );

    fireEvent.click(screen.getByText("深度思考"));
    expect(screen.getByText("我先检查代码。")).toBeInTheDocument();
    expect(screen.getByText("需要从客户端交互状态入手。")).toBeInTheDocument();
  });

  it("答案输出前展开思考，首个答案到达时立即自动收起", async () => {
    const liveMessage: ChatMessage = {
      id: "assistant-live",
      role: "assistant",
      complete: false,
      startedAt: 1_000,
      parts: [{ kind: "thought", text: "正在分析请求。" }],
    };
    const { rerender } = render(
      <ThemeProvider>
        <MessageItem message={liveMessage} streaming />
      </ThemeProvider>,
    );
    expect(screen.getByRole("button", { name: /正在分析任务/ }))
      .toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("深度思考").closest("details")).toHaveAttribute("open");

    rerender(
      <ThemeProvider>
        <MessageItem
          message={{
            ...liveMessage,
            parts: [
              ...liveMessage.parts,
              { kind: "text", text: "这是正式答案的第一部分。" },
            ],
          }}
          streaming
        />
      </ThemeProvider>,
    );
    expect(screen.getByText("这是正式答案的第一部分。")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: /已完成思考/ }))
      .toHaveAttribute("aria-expanded", "false"));
  });

  it("用户手动展开后不被后续答案输出抢夺控制权", async () => {
    const liveMessage: ChatMessage = {
      id: "assistant-manual-process",
      role: "assistant",
      complete: false,
      parts: [{ kind: "thought", text: "正在分析。" }],
    };
    const { rerender } = render(
      <ThemeProvider>
        <MessageItem message={liveMessage} streaming />
      </ThemeProvider>,
    );
    const process = screen.getByRole("button", { name: /正在分析任务/ });
    fireEvent.click(process);
    fireEvent.click(process);
    expect(process).toHaveAttribute("aria-expanded", "true");

    rerender(
      <ThemeProvider>
        <MessageItem
          message={{
            ...liveMessage,
            parts: [
              ...liveMessage.parts,
              { kind: "text", text: "开始输出正式答案。" },
            ],
          }}
          streaming
        />
      </ThemeProvider>,
    );

    await waitFor(() => expect(screen.getByRole("button", { name: /已完成思考/ }))
      .toHaveAttribute("aria-expanded", "true"));
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

    expect(screen.getByRole("button", { name: /执行未正常完成/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.queryByRole("button", { name: "复制纯文本" })).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("provider disconnected");
  });

  it("已有部分答案时失败过程仍默认展开，避免隐藏异常", () => {
    render(
      <ThemeProvider>
        <MessageItem
          message={{
            ...message,
            id: "failed-with-answer",
            stopReason: "error",
            agentResult: "upstream timeout",
          }}
          streaming={false}
        />
      </ThemeProvider>,
    );

    expect(screen.getByText("最终修复结果")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /执行未正常完成/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("alert")).toHaveTextContent("upstream timeout");
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
