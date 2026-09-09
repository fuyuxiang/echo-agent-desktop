import { beforeEach, describe, expect, it, vi } from "vitest";
import { preparePromptWithPersonalKnowledge } from "../knowledge-context";
import { registerKbProvider, resetKbRegistry } from "../knowledge-base";
import { useKnowledgeStore } from "@/stores/knowledge-store";

describe("personal knowledge prompt preparation", () => {
  beforeEach(() => {
    resetKbRegistry();
    useKnowledgeStore.setState({
      defaultMode: "auto",
      sessionModes: {},
      sourceCount: 0,
      retrievals: {},
    });
  });

  it("自然语言问题命中关键词后注入带来源的知识片段", async () => {
    registerKbProvider({
      id: "handbook",
      label: "员工手册",
      isEnabled: () => true,
      list: vi.fn((query?: string) => query?.includes("年假") ? [{
        id: "/docs/leave.md",
        title: "休假制度",
        snippet: "员工每年享有十天年假。",
        url: "/docs/leave.md",
      }] : []),
    });

    const result = await preparePromptWithPersonalKnowledge(
      "session-1",
      "公司的年假政策是什么？",
      "公司的年假政策是什么？",
    );

    expect(result.resultCount).toBe(1);
    expect(result.promptText).toContain("<echoagent_personal_knowledge>");
    expect(result.promptText).toContain("[个人知识 1] 休假制度");
    expect(result.promptText).toContain("员工每年享有十天年假");
    expect(result.promptText).toContain("公司的年假政策是什么？");
    expect(useKnowledgeStore.getState().retrievals["session-1"]).toMatchObject({
      state: "used",
      resultCount: 1,
    });
  });

  it("会话关闭知识库后完全跳过检索", async () => {
    const list = vi.fn(() => [{ id: "x", title: "不应读取" }]);
    registerKbProvider({ id: "local", label: "本地", isEnabled: () => true, list });
    useKnowledgeStore.getState().setSessionMode("session-off", "off");

    const result = await preparePromptWithPersonalKnowledge("session-off", "原始提示", "用户问题");

    expect(result.promptText).toBe("原始提示");
    expect(list).not.toHaveBeenCalled();
  });

  it("知识源失败不会阻止原任务发送，并留下可见错误状态", async () => {
    registerKbProvider({
      id: "broken",
      label: "失效目录",
      isEnabled: () => true,
      list: async () => { throw new Error("目录不可读"); },
    });

    const result = await preparePromptWithPersonalKnowledge("session-2", "继续完成任务", "查找规范");

    expect(result.promptText).toBe("继续完成任务");
    expect(useKnowledgeStore.getState().retrievals["session-2"]).toMatchObject({
      state: "error",
      message: expect.stringContaining("目录不可读"),
    });
  });
});
