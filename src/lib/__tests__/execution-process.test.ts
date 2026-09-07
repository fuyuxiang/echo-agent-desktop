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
  it("把工具前说明归入过程，把最后文本保留为答复", () => {
    const result = partitionAssistantParts([
      { kind: "text", text: "我先检查项目。" },
      { kind: "thought", text: "需要确认入口。" },
      tool("completed"),
      { kind: "text", text: "修复已经完成。" },
    ]);

    expect(result.processParts).toHaveLength(3);
    expect(result.responseParts.map((part) => part.text)).toEqual(["修复已经完成。"]);
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
});

describe("formatProcessDuration", () => {
  it("生成人类可读时长", () => {
    expect(formatProcessDuration(8_900)).toBe("8秒");
    expect(formatProcessDuration(65_000)).toBe("1分5秒");
  });
});
