import { beforeEach, describe, expect, it } from "vitest";
import {
  indexTaskArtifacts,
  loadTaskArtifacts,
  mergeTaskArtifacts,
  taskArtifactsFromMessages,
  type TaskArtifact,
} from "../artifact-catalog";
import type { ChatMessage } from "@/stores/session-store";

function toolMessage(kind: string, title: string, path: string): ChatMessage {
  return {
    id: `${kind}-${path}`,
    role: "assistant",
    complete: true,
    parts: [{
      kind: "tool_call",
      toolCall: {
        toolCallId: `${kind}-${path}`,
        title,
        kind,
        status: "completed",
        content: [{ type: "diff", diff: { path, old: "", new: "content" } }],
      },
    }],
  };
}

describe("artifact catalog", () => {
  beforeEach(() => window.localStorage.removeItem("echoagent.task-artifacts.v1"));

  it("只收录产出型工具，排除纯读取路径", () => {
    const entries = taskArtifactsFromMessages("s1", "任务", "/work", [
      toolMessage("read", "Read /work/input.md", "/work/input.md"),
      toolMessage("edit", "Write /work/output.md", "/work/output.md"),
    ], 10);
    expect(entries.map((item) => item.path)).toEqual(["/work/output.md"]);
    expect(entries[0]).toMatchObject({ sessionId: "s1", sessionTitle: "任务", cwd: "/work" });
  });

  it("重新索引会替换该会话旧成果并持久化", () => {
    indexTaskArtifacts("s1", "任务1", "/w", [toolMessage("edit", "Write a.md", "a.md")]);
    indexTaskArtifacts("s1", "任务1", "/w", [toolMessage("edit", "Write b.md", "b.md")]);
    indexTaskArtifacts("s2", "任务2", "/w", [toolMessage("edit", "Write c.md", "c.md")]);
    expect(loadTaskArtifacts().map((item) => item.path).sort()).toEqual(["b.md", "c.md"]);
  });

  it("合并时以更新的同会话同路径记录为准", () => {
    const base = {
      id: "a", path: "A.md", kind: "edit", title: "Write", toolCallId: "t",
      status: "completed", sessionId: "s", sessionTitle: "old", cwd: "/w",
    } as TaskArtifact;
    expect(mergeTaskArtifacts(
      [{ ...base, updatedAt: 1 }],
      [{ ...base, path: "a.md", sessionTitle: "new", updatedAt: 2 }],
    )[0].sessionTitle).toBe("new");
  });
});
