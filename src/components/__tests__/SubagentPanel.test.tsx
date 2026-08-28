import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { SubagentPanel } from "../SubagentPanel";
import { useSubagentStore } from "@/stores/subagent-store";
import { useSessionStore } from "@/stores/session-store";
import type { ChatMessage } from "@/stores/session-store";
import type { SubagentLiveEvent } from "@/lib/types";

function spawnMsg(
  id: string,
  title: string,
  status: "in_progress" | "completed" | "failed",
): ChatMessage {
  return {
    id: "msg-" + id,
    role: "assistant",
    complete: true,
    parts: [
      {
        kind: "tool_call",
        toolCall: {
          toolCallId: id,
          title,
          kind: "spawn_subagent",
          status,
          content: [],
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

  it("无 subagent 时不渲染", () => {
    const { container } = render(<SubagentPanel messages={[]} />);
    expect(container.firstChild).toBeNull();
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
    // Same subagent in both live and transcript — live wins.
    useSubagentStore.getState().applyEvent({
      sessionId: "s1",
      phase: "spawned",
      subagentId: "dup1",
      description: "实时子代理",
      status: "running",
    });
    useSessionStore.setState({ sessionId: "s1" });

    render(
      <SubagentPanel
        messages={[
          spawnMsg("dup1", "Spawn subagent: dup1", "in_progress"),
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
});
