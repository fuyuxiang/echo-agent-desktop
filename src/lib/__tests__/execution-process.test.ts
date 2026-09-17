import { describe, expect, it } from "vitest";
import {
  formatProcessDuration,
  partitionAssistantParts,
  summarizeExecutionProcess,
} from "../execution-process";
import type { MessagePart } from "@/stores/session-store";

const tool = (
  status: "in_progress" | "completed" | "failed",
  kind = "edit_file",
): MessagePart => ({
  kind: "tool_call",
  toolCall: {
    toolCallId: `${kind}-${status}`,
    title: "Edit src/App.tsx",
    kind,
    status,
    content: [{
      type: "diff",
      diff: { path: "src/App.tsx", old: "a", new: "b" },
    }],
  },
});

describe("partitionAssistantParts", () => {
  it("把工具前的模型说明归入过程，只保留尾部答复", () => {
    const result = partitionAssistantParts([
      { kind: "text", text: "我先检查项目。" },
      { kind: "thought", text: "需要确认入口。" },
      tool("completed"),
      { kind: "text", text: "修复已经完成。" },
    ]);

    expect(result.processParts).toHaveLength(3);
    expect(result.responseParts.map((part) => part.text)).toEqual(["修复已经完成。"]);
  });

  it("优先用模型生成标识区分多轮工具过程和最终答复", () => {
    const firstTool = tool("completed");
    const result = partitionAssistantParts([
      { kind: "text", text: "I should inspect the project first.", streamId: "generation-1" },
      { ...firstTool, streamId: "generation-1" },
      { kind: "thought", text: "整理最终结论", streamId: "generation-2" },
      { kind: "text", text: "这是最终答案。", streamId: "generation-2" },
    ]);

    expect(result.processParts.map((part) => part.kind)).toEqual([
      "text",
      "tool_call",
      "thought",
    ]);
    expect(result.responseParts.map((part) => part.text)).toEqual(["这是最终答案。"]);
  });

  it("拆分同一文本块中的 think 标签和正式答案", () => {
    const result = partitionAssistantParts([{
      kind: "text",
      text: "<think>Internal English analysis.\nCheck the timeout.</think>\n\n调用大模型超时通常由网络问题导致。",
      streamId: "generation-1",
    }]);

    expect(result.processParts).toEqual([{
      kind: "thought",
      text: "Internal English analysis.\nCheck the timeout.",
      streamId: "generation-1",
    }]);
    expect(result.responseParts).toEqual([{
      kind: "text",
      text: "调用大模型超时通常由网络问题导致。",
      streamId: "generation-1",
    }]);
  });

  it("流式 think 标签未闭合时也只当作思考过程", () => {
    const result = partitionAssistantParts([{
      kind: "text",
      text: "<think>Still reasoning",
      streamId: "generation-1",
    }]);

    expect(result.processParts).toEqual([{
      kind: "thought",
      text: "Still reasoning",
      streamId: "generation-1",
    }]);
    expect(result.responseParts).toEqual([]);
  });

  it.each([
    ["thinking", "<thinking>Reasoning</thinking>Answer"],
    ["reasoning", "<REASONING mode=\"deep\">Reasoning</REASONING>Answer"],
    ["analysis", "<analysis>Reasoning</analysis>Answer"],
  ])("兼容 %s 推理标签", (_tag, text) => {
    const result = partitionAssistantParts([{ kind: "text", text }]);
    expect(result.processParts).toEqual([{ kind: "thought", text: "Reasoning" }]);
    expect(result.responseParts).toEqual([{ kind: "text", text: "Answer" }]);
  });

  it("不会误伤正式答案中间的标签示例", () => {
    const text = "XML 示例：<think>demo</think>";
    const result = partitionAssistantParts([{ kind: "text", text }]);
    expect(result.processParts).toEqual([]);
    expect(result.responseParts).toEqual([{ kind: "text", text }]);
  });

  it("没有尾部答复时不把已有文本藏进折叠过程", () => {
    const result = partitionAssistantParts([
      { kind: "text", text: "这是可见结果" },
      tool("completed"),
    ]);

    expect(result.responseParts.map((part) => part.text)).toEqual(["这是可见结果"]);
    expect(result.processParts.every((part) => part.kind !== "text")).toBe(true);
  });

  it("普通问答不生成过程组", () => {
    const result = partitionAssistantParts([{ kind: "text", text: "直接回答" }]);
    expect(result.processParts).toEqual([]);
    expect(result.responseParts[0].text).toBe("直接回答");
  });
});

describe("summarizeExecutionProcess", () => {
  it("用语义状态描述当前操作并统计文件", () => {
    const summary = summarizeExecutionProcess([
      { kind: "thought", text: "分析" },
      tool("completed"),
      tool("in_progress"),
    ], true);

    expect(summary.title).toBe("正在修改文件");
    expect(summary.state).toBe("running");
    expect(summary.completedToolCount).toBe(1);
    expect(summary.toolCount).toBe(2);
    expect(summary.changedFiles).toEqual(["src/App.tsx"]);
  });

  it("失败项保持为注意状态", () => {
    const summary = summarizeExecutionProcess([tool("failed", "bash")], false);
    expect(summary.state).toBe("attention");
    expect(summary.title).toContain("失败");
  });

  it("用户取消后明确显示已停止，而不是伪装成完成", () => {
    const summary = summarizeExecutionProcess([tool("completed", "bash")], false, "cancelled");
    expect(summary.state).toBe("stopped");
    expect(summary.title).toBe("已停止执行");
  });

  it("区分权限拒绝与安全规则阻止", () => {
    const rejected = summarizeExecutionProcess([], false, "cancelled", "PermissionRejected");
    const blocked = summarizeExecutionProcess([], false, "cancelled", "HookDenied");
    expect(rejected.state).toBe("stopped");
    expect(rejected.title)
      .toBe("权限未批准，执行已停止");
    expect(blocked).toMatchObject({
      state: "attention",
      title: "执行被安全规则阻止",
    });
  });

  it("终止时仍有未收尾操作会标记为需要注意", () => {
    const summary = summarizeExecutionProcess([tool("in_progress", "bash")], false, "end_turn");
    expect(summary.state).toBe("attention");
    expect(summary.title).toContain("未收尾");
  });
});

describe("formatProcessDuration", () => {
  it("生成人类可读时长", () => {
    expect(formatProcessDuration(8_900)).toBe("8秒");
    expect(formatProcessDuration(65_000)).toBe("1分5秒");
  });
});
