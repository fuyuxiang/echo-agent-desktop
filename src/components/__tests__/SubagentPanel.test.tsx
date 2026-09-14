import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SubagentPanel } from "../SubagentPanel";
import { useSubagentStore } from "@/stores/subagent-store";
import { useSessionStore } from "@/stores/session-store";
import type { ChatMessage } from "@/stores/session-store";
import type { SubagentLiveEvent } from "@/lib/types";

function spawnMsg(
  id: string,
  title: string,
  status: "in_progress" | "completed" | "failed",
  options?: { rawInput?: unknown; resultText?: string; promptId?: string },
): ChatMessage {
  return {
    id: "msg-" + id,
    role: "assistant",
    complete: true,
    promptId: options?.promptId,
    parts: [
      {
        kind: "tool_call",
        toolCall: {
          toolCallId: id,
          title,
          kind: "spawn_subagent",
          status,
          content: options?.resultText
            ? [{ type: "text", text: options.resultText }]
            : [],
          rawInput: options?.rawInput,
        },
      },
    ],
  };
}

describe("SubagentPanel", () => {
  beforeEach(() => {
    useSubagentStore.setState({ bySession: {} });
    useSessionStore.setState({ sessionId: null });
  });

  it("无 subagent 时给出明确空状态", () => {
    render(<SubagentPanel messages={[]} />);
    expect(screen.getByText(/尚未派发子代理/)).toBeInTheDocument();
  });

  it("从 spawn_subagent transcript 派生并展示", () => {
    render(<SubagentPanel messages={[spawnMsg("t1", "Spawn subagent: coder", "completed")]} />);
    expect(screen.getByText("子代理")).toBeInTheDocument();
    expect(screen.getByText("coder")).toBeInTheDocument();
    expect(screen.getByText("已完成")).toBeInTheDocument();
  });

  it("汇总统计(总数/运行中/完成)", () => {
    render(
      <SubagentPanel
        messages={[
          spawnMsg("t1", "Spawn subagent: a", "completed"),
          spawnMsg("t2", "Spawn subagent: b", "in_progress"),
        ]}
      />,
    );
    expect(screen.getByText(/2 个/)).toBeInTheDocument();
    expect(screen.getByText(/运行中 1/)).toBeInTheDocument();
    expect(screen.getByText(/完成 1/)).toBeInTheDocument();
  });

  it("live store 事件渲染实时进度(轮次/工具/时长)", () => {
    const evt: SubagentLiveEvent = {
      sessionId: "s1",
      phase: "progress",
      subagentId: "sa1",
      childSessionId: "sa1",
      description: "搜索代码库",
      subagentType: "explore",
      status: "running",
      durationMs: 5300,
      turnCount: 3,
      toolCallCount: 7,
      tokensUsed: 12500,
      contextUsagePct: 42,
      toolsUsed: ["read_file", "grep", "run_terminal_command"],
    };
    useSubagentStore.getState().applyEvent(evt);
    useSessionStore.setState({ sessionId: "s1" });

    render(<SubagentPanel messages={[]} />);
    expect(screen.getByText("搜索代码库")).toBeInTheDocument();
    expect(screen.getByText(/3 轮/)).toBeInTheDocument();
    expect(screen.getByText(/7 工具/)).toBeInTheDocument();
    expect(screen.getByText("运行中")).toBeInTheDocument();
  });

  it("live + transcript 合并去重(live 优先)", () => {
    // Runtime id and ACP tool-call id are deliberately different. The task
    // result carries the true child id and must still merge into one row.
    useSubagentStore.getState().applyEvent({
      sessionId: "s1",
      phase: "spawned",
      subagentId: "child-1",
      description: "实时子代理",
      status: "running",
    });
    useSessionStore.setState({ sessionId: "s1" });

    render(
      <SubagentPanel
        messages={[
          spawnMsg("tool-call-1", "Task: fallback", "in_progress", {
            resultText: "Subagent moved to the background and is still running.\nsubagent_id: child-1\ntype: explore",
          }),
          spawnMsg("t2", "Spawn subagent: other", "completed"),
        ]}
      />,
    );
    // Should show 2 total: live "实时子代理" + transcript "other"
    expect(screen.getByText(/2 个/)).toBeInTheDocument();
    expect(screen.getByText("实时子代理")).toBeInTheDocument();
    expect(screen.getByText("other")).toBeInTheDocument();
  });

  it("失败统计显示", () => {
    render(<SubagentPanel messages={[spawnMsg("t1", "Spawn subagent: x", "failed")]} />);
    expect(screen.getByText(/失败 1/)).toBeInTheDocument();
    expect(screen.getByText("失败")).toBeInTheDocument();
  });

  it("展开后展示完整任务、最终产出和处理凭证", () => {
    useSubagentStore.getState().applyEvent({
      sessionId: "s1",
      phase: "spawned",
      subagentId: "child-7",
      childSessionId: "child-7",
      parentPromptId: "prompt-7",
      description: "核验历史记录",
      subagentType: "explore",
      model: "model-a",
      status: "running",
    });
    useSubagentStore.getState().applyEvent({
      sessionId: "s1",
      phase: "finished",
      subagentId: "child-7",
      childSessionId: "child-7",
      status: "completed",
      output: "确认历史生命周期事件可以完整回放。",
      toolCallCount: 9,
      turnCount: 2,
    });
    useSessionStore.setState({ sessionId: "s1" });
    const openSession = vi.fn();

    render(
      <SubagentPanel
        cwd="/workspace"
        onOpenSession={openSession}
        messages={[
          spawnMsg("tool-7", "Task: fallback", "completed", {
            promptId: "prompt-7",
            rawInput: {
              task_id: "child-7",
              description: "核验历史记录",
              prompt: "检查多轮子代理记录是否可以持久化并恢复。",
              subagent_type: "explore",
            },
          }),
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /核验历史记录/ }));
    expect(screen.getByText("检查多轮子代理记录是否可以持久化并恢复。")).toBeInTheDocument();
    expect(screen.getByText("确认历史生命周期事件可以完整回放。")).toBeInTheDocument();
    expect(screen.getByText("child-7")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /打开完整工作记录/ }));
    expect(openSession).toHaveBeenCalledWith("child-7", "/workspace");
  });

  it("按父 prompt 将历史子代理分轮展示", () => {
    const user = (id: string, text: string): ChatMessage => ({
      id,
      role: "user",
      complete: true,
      parts: [{ kind: "text", text }],
    });
    render(
      <SubagentPanel
        messages={[
          user("u1", "第一轮需求"),
          spawnMsg("t1", "Task: 第一项", "completed", { promptId: "p1" }),
          user("u2", "第二轮需求"),
          spawnMsg("t2", "Task: 第二项", "completed", { promptId: "p2" }),
        ]}
      />,
    );
    expect(screen.getByText("历史 · 第 1 轮")).toBeInTheDocument();
    expect(screen.getByText("当前轮次 · 第 2 轮")).toBeInTheDocument();
    expect(screen.getByText("第一轮需求")).toBeInTheDocument();
    expect(screen.getByText("第二轮需求")).toBeInTheDocument();
  });
});
