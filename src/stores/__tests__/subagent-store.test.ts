import { beforeEach, describe, expect, it } from "vitest";
import { useSubagentStore } from "../subagent-store";

describe("subagent-store durable lifecycle merge", () => {
  beforeEach(() => {
    useSubagentStore.setState({ bySession: {} });
  });

  it("reconstructs provenance and final evidence from replay", () => {
    const store = useSubagentStore.getState();
    store.applyEvent({
      sessionId: "parent",
      phase: "spawned",
      subagentId: "child",
      childSessionId: "child",
      parentPromptId: "prompt-3",
      description: "检查数据层",
      subagentType: "explore",
      model: "model-a",
      capabilityMode: "read-only",
      occurredAt: 1_788_000_000_000,
      isReplay: true,
    });
    store.applyEvent({
      sessionId: "parent",
      phase: "finished",
      subagentId: "child",
      status: "completed",
      durationMs: 4800,
      turnCount: 2,
      toolCallCount: 11,
      output: "数据层正常",
      isReplay: true,
    });

    expect(useSubagentStore.getState().getForSession("parent")[0]).toMatchObject({
      id: "child",
      childSessionId: "child",
      parentPromptId: "prompt-3",
      description: "检查数据层",
      subagentType: "explore",
      model: "model-a",
      capabilityMode: "read-only",
      status: "completed",
      durationMs: 4800,
      turnCount: 2,
      toolCallCount: 11,
      output: "数据层正常",
      isReplay: true,
    });
  });

  it("late spawn/progress enrich terminal records without regressing status", () => {
    const store = useSubagentStore.getState();
    store.applyEvent({
      sessionId: "parent",
      phase: "finished",
      subagentId: "child",
      status: "completed",
      output: "已完成",
    });
    store.applyEvent({
      sessionId: "parent",
      phase: "spawned",
      subagentId: "child",
      description: "迟到的任务摘要",
      status: "running",
    });
    store.applyEvent({
      sessionId: "parent",
      phase: "progress",
      subagentId: "child",
      status: "running",
      toolCallCount: 7,
    });

    expect(useSubagentStore.getState().getForSession("parent")[0]).toMatchObject({
      description: "迟到的任务摘要",
      status: "completed",
      output: "已完成",
      toolCallCount: 7,
    });
  });
});
