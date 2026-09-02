import { beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { beginAgentTurn, type AgentTurnSender } from "../agent-turn";
import { useSessionStore } from "@/stores/session-store";
import { useSessionsStore } from "@/stores/sessions-store";

function resetStores() {
  useSessionStore.setState({
    sessionId: null,
    transcripts: {},
    messages: [],
    streaming: false,
    streamingMessageId: null,
    usage: {},
    plan: null,
    error: null,
    planMode: false,
  });
  useSessionsStore.setState({
    independent: [],
    workspaceSessions: {},
    homeCwd: "/tmp",
    currentSessionId: null,
  });
}

describe("beginAgentTurn", () => {
  beforeEach(resetStores);

  it("立即接纳用户消息和附件，不等待整轮 ACP 请求完成", () => {
    useSessionStore.getState().setSession("s1");
    let resolveSend!: () => void;
    const send = vi.fn(() => new Promise<void>((resolve) => {
      resolveSend = resolve;
    })) as AgentTurnSender;

    const accepted = beginAgentTurn({
      sessionId: "s1",
      promptText: "模型完整提示",
      displayText: "请优化文档",
      attachments: ["/tmp/数据回流方案.docx"],
    }, send);

    const state = useSessionStore.getState();
    expect(accepted).toBe(true);
    expect(state.streaming).toBe(true);
    expect(state.messages[0]).toMatchObject({
      role: "user",
      attachments: ["/tmp/数据回流方案.docx"],
      complete: true,
    });
    expect(state.messages[0].parts).toEqual([
      { kind: "text", text: "请优化文档" },
    ]);
    expect(send).toHaveBeenCalledWith(
      "s1",
      "模型完整提示",
      ["/tmp/数据回流方案.docx"],
      "请优化文档",
    );

    // The unresolved model turn is deliberately left pending until after all
    // immediate assertions: beginAgentTurn itself must already have returned.
    resolveSend();
  });

  it("延迟失败保留已提交的用户附件，并结束等待占位", async () => {
    useSessionStore.getState().setSession("s1");
    const send = vi.fn(() => Promise.reject(new Error("附件读取失败"))) as AgentTurnSender;

    beginAgentTurn({
      sessionId: "s1",
      promptText: "请优化",
      displayText: "请优化",
      attachments: ["/tmp/方案.docx"],
    }, send);

    await waitFor(() => expect(useSessionStore.getState().streaming).toBe(false));
    const state = useSessionStore.getState();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].attachments).toEqual(["/tmp/方案.docx"]);
    expect(state.error).toContain("附件读取失败");
    expect(useSessionsStore.getState().independent[0].status).toBe("failed");
  });

  it("会话已切换时拒绝旧界面的迟到提交", () => {
    useSessionStore.getState().setSession("new-session");
    const send = vi.fn(() => Promise.resolve()) as AgentTurnSender;

    const accepted = beginAgentTurn({
      sessionId: "stale-session",
      promptText: "stale",
      displayText: "stale",
      attachments: ["/tmp/stale.docx"],
    }, send);

    expect(accepted).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(useSessionStore.getState().messages).toEqual([]);
  });
});
