import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { useKnowledgeStore } from "@/stores/knowledge-store";
import {
  agentCancel,
  invalidateAgentKnowledgeSourceSync,
  agentSend,
  agentSendNow,
  commandsList,
  memoryClearSessionSummaries,
  memoryDelete,
  memoryFlush,
  memoryRewrite,
  memorySave,
} from "../agent-client";

const invokeMock = vi.mocked(invoke);

describe("agentSend attachment contract", () => {
  beforeEach(() => {
    invalidateAgentKnowledgeSourceSync();
    invokeMock.mockReset();
    invokeMock.mockImplementation((command) => Promise.resolve(
      command === "agent_set_knowledge_sources"
        ? {
            personalSelected: false,
            organizationSelected: false,
            personalAttached: false,
            organizationAttached: false,
          }
        : undefined,
    ));
    useKnowledgeStore.setState({
      defaultSources: [],
      defaultOrganizationScopeIds: [],
      sessionSources: {},
      sessionOrganizationScopeIds: {},
      retrievals: {},
      turnTraces: {},
    });
  });

  it("分离传递模型正文、附件和用户可见正文", async () => {
    await agentSend(
      "session-1",
      "<system-reminder>hidden</system-reminder>\n\n请优化",
      ["/tmp/方案.docx"],
      "请优化",
    );
    expect(invokeMock).toHaveBeenCalledWith("agent_send", {
      sessionId: "session-1",
      text: "<system-reminder>hidden</system-reminder>\n\n请优化",
      attachments: ["/tmp/方案.docx"],
      displayText: "请优化",
      promptId: null,
      sendNow: false,
    });
    expect(invokeMock).toHaveBeenCalledWith("agent_set_knowledge_sources", {
      sessionId: "session-1",
      personal: false,
      organization: false,
      organizationScopeIds: [],
    });
  });

  it("立即发送通过同一 ACP prompt 传递 sendNow 和 promptId", async () => {
    await agentSendNow("session-1", "2", [], "2", "prompt-2");
    expect(invokeMock).toHaveBeenCalledWith("agent_send", {
      sessionId: "session-1",
      text: "2",
      attachments: [],
      displayText: "2",
      promptId: "prompt-2",
      sendNow: true,
    });
  });

  it("暂停取消携带动作和当前 promptId", async () => {
    await agentCancel("session-1", "pause", "prompt-1");
    expect(invokeMock).toHaveBeenCalledWith("agent_cancel", {
      sessionId: "session-1",
      cancelAction: "pause",
      promptId: "prompt-1",
    });
  });

  it("知识来源未变化时复用原生同步结果", async () => {
    await agentSend("session-cache", "第一条");
    await agentSend("session-cache", "第二条");

    expect(invokeMock.mock.calls.filter(([command]) => (
      command === "agent_set_knowledge_sources"
    ))).toHaveLength(1);
    expect(invokeMock.mock.calls.filter(([command]) => command === "agent_send")).toHaveLength(2);
  });

  it("组织知识同步失败时阻止未经知识库支撑的回答", async () => {
    useKnowledgeStore.getState().setSessionSources("session-org", ["organization"]);
    invokeMock.mockImplementation((command) => (
      command === "agent_set_knowledge_sources"
        ? Promise.reject(new Error("组织连接超时"))
        : Promise.resolve(undefined)
    ));

    await expect(agentSend("session-org", "继续原任务", [], "继续原任务", "prompt-org"))
      .rejects.toThrow("本次消息未发送");

    expect(invokeMock.mock.calls.some(([command]) => command === "agent_send")).toBe(false);
    expect(useKnowledgeStore.getState().turnTraces["session-org"]["prompt-org"])
      .toMatchObject({
        organization: {
          state: "unavailable",
          message: expect.stringContaining("组织连接超时"),
        },
      });
  });

  it("原生层未确认所选个人知识工具就绪时不缓存假成功", async () => {
    useKnowledgeStore.getState().setSessionSources("session-personal", ["personal"]);
    invokeMock.mockImplementation((command) => Promise.resolve(
      command === "agent_set_knowledge_sources"
        ? {
            personalSelected: true,
            organizationSelected: false,
            personalAttached: false,
            organizationAttached: false,
          }
        : undefined,
    ));

    await expect(agentSend(
      "session-personal",
      "总结我的文档",
      [],
      "总结我的文档",
      "prompt-personal",
    )).rejects.toThrow("个人知识库尚未就绪");

    expect(invokeMock.mock.calls.some(([command]) => command === "agent_send")).toBe(false);
    expect(useKnowledgeStore.getState().turnTraces["session-personal"]["prompt-personal"])
      .toMatchObject({
        personal: {
          state: "error",
          message: expect.stringContaining("个人知识库尚未就绪"),
        },
      });
  });

  it("组织知识工具实际就绪后才发送消息", async () => {
    useKnowledgeStore.getState().setSessionSources("session-org-ready", ["organization"]);
    invokeMock.mockImplementation((command) => Promise.resolve(
      command === "agent_set_knowledge_sources"
        ? {
            personalSelected: false,
            organizationSelected: true,
            personalAttached: false,
            organizationAttached: true,
          }
        : undefined,
    ));

    await expect(agentSend(
      "session-org-ready",
      "组织知识是什么",
      [],
      "组织知识是什么",
      "prompt-org-ready",
    )).resolves.toBeUndefined();

    expect(invokeMock).toHaveBeenCalledWith("agent_send", expect.objectContaining({
      sessionId: "session-org-ready",
    }));
    expect(useKnowledgeStore.getState().turnTraces["session-org-ready"]["prompt-org-ready"])
      .toMatchObject({ organization: { state: "available" } });
  });

  it("将任务选定的组织范围下发给原生层", async () => {
    useKnowledgeStore.getState().setSessionSources("session-org-scope", ["organization"]);
    useKnowledgeStore.getState().setSessionOrganizationScopeIds("session-org-scope", ["team-1"]);
    invokeMock.mockImplementation((command) => Promise.resolve(
      command === "agent_set_knowledge_sources"
        ? {
            personalSelected: false,
            organizationSelected: true,
            personalAttached: false,
            organizationAttached: true,
          }
        : undefined,
    ));

    await agentSend("session-org-scope", "检索团队知识");

    expect(invokeMock).toHaveBeenCalledWith("agent_set_knowledge_sources", {
      sessionId: "session-org-scope",
      personal: false,
      organization: true,
      organizationScopeIds: ["team-1"],
    });
  });
});

describe("commandsList", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue([]);
  });

  it("把会话和工作目录上下文传给 Tauri 后端", async () => {
    await commandsList("session-1", "/repo");

    expect(invokeMock).toHaveBeenCalledWith("commands_list", {
      sessionId: "session-1",
      cwd: "/repo",
    });
  });

  it("无上下文时显式传 null，保持 Tauri 参数稳定", async () => {
    await commandsList();

    expect(invokeMock).toHaveBeenCalledWith("commands_list", {
      sessionId: null,
      cwd: null,
    });
  });
});

describe("memory command contract", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it("落盘和重写携带 Runtime 必需参数", async () => {
    invokeMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce("rewritten");
    await memoryFlush("session-1");
    await expect(memoryRewrite("session-1", "raw", "global memory")).resolves.toBe("rewritten");

    expect(invokeMock).toHaveBeenNthCalledWith(1, "memory_flush", { sessionId: "session-1" });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "memory_rewrite", {
      sessionId: "session-1",
      rawText: "raw",
      contextSummary: "global memory",
    });
  });

  it("写入和删除传递期望修订号", async () => {
    await memorySave("global", "MEMORY.md", "body", "/repo", "revision-1");
    await memoryDelete("global", "MEMORY.md", "/repo", "revision-2");

    expect(invokeMock).toHaveBeenNthCalledWith(1, "memory_save", {
      scope: "global",
      path: "MEMORY.md",
      content: "body",
      cwd: "/repo",
      expectedRevision: "revision-1",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "memory_delete", {
      scope: "global",
      path: "MEMORY.md",
      cwd: "/repo",
      expectedRevision: "revision-2",
    });
  });

  it("清空会话摘要时传递工作区", async () => {
    invokeMock.mockResolvedValueOnce(3);
    await expect(memoryClearSessionSummaries("/repo")).resolves.toBe(3);
    expect(invokeMock).toHaveBeenCalledWith("memory_clear_session_summaries", {
      cwd: "/repo",
    });
  });
});
