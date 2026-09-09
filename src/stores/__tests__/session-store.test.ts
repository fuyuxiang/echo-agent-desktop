import { describe, it, expect, beforeEach } from "vitest";
import { useSessionStore } from "../session-store";

/**
 * Per-session transcript store. The whole point of this refactor is that
 * switching sessions must NOT lose the locally-optimistic user bubbles, and a
 * session that keeps streaming in the background must keep accumulating into
 * its own transcript so a switch-back shows the full, live state.
 *
 * We feed `applyUpdate` plain objects shaped like the wire payload: a
 * `sessionUpdate` tag + `content`/fields, plus the side-channel `__sessionId`
 * the bridge attaches.
 */

const resetStore = () => {
  localStorage.removeItem("echoagent.session-controls.v1");
  useSessionStore.setState({
    sessionId: null,
    transcripts: {},
    messages: [],
    streaming: false,
    sendNowPending: false,
    streamingMessageId: null,
    usage: {},
    plan: null,
    planApproval: null,
    control: undefined,
    error: null,
    planMode: false,
  });
};

// Wire-shaped payloads; cast loosely — we only care about runtime routing here.
const chunk = (text: string, sid: string) =>
  ({
    sessionUpdate: "agent_message_chunk",
    content: { text },
    __sessionId: sid,
  }) as unknown as Parameters<
    ReturnType<typeof useSessionStore.getState>["applyUpdate"]
  >[0];

const userChunk = (
  content: Record<string, unknown>,
  sid: string,
  promptIndex = 0,
) =>
  ({
    sessionUpdate: "user_message_chunk",
    content,
    _meta: { promptIndex },
    __sessionId: sid,
  }) as unknown as Parameters<
    ReturnType<typeof useSessionStore.getState>["applyUpdate"]
  >[0];

const complete = (sid: string, totalTokens = 0) =>
  ({
    sessionId: sid,
    usage: { totalTokens },
  }) as unknown as Parameters<
    ReturnType<typeof useSessionStore.getState>["markComplete"]
  >[0];

const textOf = (idx: number) => {
  const m = useSessionStore.getState().messages[idx];
  return userMessageTextForTest(m);
};

const userMessageTextForTest = (m: ReturnType<typeof useSessionStore.getState>["messages"][number]) => {
  return m.parts
    .filter((p) => p.kind === "text")
    .map((p) => (p as { text: string }).text)
    .join("");
};

describe("session-store transcripts", () => {
  beforeEach(resetStore);

  it("暂停建立会话屏障，切换任务后仍保留且迟到增量不能复活", () => {
    const store = useSessionStore.getState();
    store.setSession("A");
    store.startStreaming("A", "prompt-a");
    store.applyUpdate(chunk("已生成", "A"));
    store.requestControl("A", "pause", "prompt-a");
    expect(useSessionStore.getState()).toMatchObject({
      streaming: false,
      control: { action: "pause", phase: "pausing" },
    });

    useSessionStore.getState().confirmControl("A", "pause");
    useSessionStore.getState().setSession("B");
    useSessionStore.getState().setSession("A");
    expect(useSessionStore.getState().control).toMatchObject({
      action: "pause",
      phase: "paused",
    });

    useSessionStore.getState().applyUpdate(chunk("不应出现", "A"));
    const assistant = useSessionStore.getState().messages.find((message) => message.role === "assistant");
    expect(assistant?.parts).toEqual([{ kind: "text", text: "已生成" }]);
    expect(useSessionStore.getState().streaming).toBe(false);
  });

  it("取消请求发送失败会撤销屏障并恢复原流", () => {
    const store = useSessionStore.getState();
    store.setSession("A");
    store.startStreaming("A", "prompt-a");
    store.requestControl("A", "stop", "prompt-a");
    expect(useSessionStore.getState().streaming).toBe(false);
    useSessionStore.getState().rejectControl("A", "stop");
    expect(useSessionStore.getState().streaming).toBe(true);
    expect(useSessionStore.getState().control).toBeUndefined();
  });

  it("稳定的暂停状态在 renderer 重载后按 session 恢复", () => {
    const store = useSessionStore.getState();
    store.setSession("A");
    store.startStreaming("A", "prompt-a");
    store.requestControl("A", "pause", "prompt-a");
    store.confirmControl("A", "pause");

    useSessionStore.setState({
      sessionId: null,
      transcripts: {},
      messages: [],
      streaming: false,
      sendNowPending: false,
      streamingMessageId: null,
      control: undefined,
    });
    useSessionStore.getState().setSession("A");
    expect(useSessionStore.getState().control).toMatchObject({
      action: "pause",
      phase: "paused",
      promptId: "prompt-a",
    });
  });

  it("用户显式发送新轮次会解除已停止状态并重新接收增量", () => {
    const store = useSessionStore.getState();
    store.setSession("A");
    store.startStreaming("A", "prompt-a");
    store.requestControl("A", "stop", "prompt-a");
    store.confirmControl("A", "stop");
    useSessionStore.getState().startStreaming("A", "prompt-b");
    useSessionStore.getState().applyUpdate(chunk("新轮次", "A"));
    expect(useSessionStore.getState().control).toBeUndefined();
    expect(useSessionStore.getState().streaming).toBe(true);
    const messages = useSessionStore.getState().messages;
    expect(messages[messages.length - 1]?.parts).toEqual([
      { kind: "text", text: "新轮次" },
    ]);
  });

  it("恢复后的旧取消终态不会再次暂停新轮次", () => {
    const store = useSessionStore.getState();
    store.setSession("A");
    store.startStreaming("A", "prompt-old");
    store.requestControl("A", "pause", "prompt-old");
    store.confirmControl("A", "pause");
    store.resumeSession("A");
    store.startStreaming("A", "prompt-new");

    store.applyUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { text: "旧轮迟到内容" },
      _meta: { promptId: "prompt-old" },
      __sessionId: "A",
    } as never);

    store.markComplete({
      sessionId: "A",
      promptId: "prompt-old",
      stopReason: "cancelled",
      cancelTrigger: "pause",
    });

    expect(useSessionStore.getState().control).toBeUndefined();
    expect(useSessionStore.getState().streaming).toBe(true);
    expect(useSessionStore.getState().messages.find(
      (message) => message.promptId === "prompt-new",
    )).toMatchObject({ complete: false, parts: [] });
  });

  it("plan mode 按会话隔离并消费权威 current_mode_update", () => {
    const store = useSessionStore.getState();
    store.setSession("A");
    store.applyUpdate({
      sessionUpdate: "current_mode_update",
      currentModeId: "plan",
      __sessionId: "A",
    } as never);
    store.setSession("B");
    expect(useSessionStore.getState().planMode).toBe(false);
    store.setSession("A");
    expect(useSessionStore.getState().planMode).toBe(true);
    store.applyUpdate({
      sessionUpdate: "current_mode_update",
      currentModeId: "default",
      __sessionId: "A",
    } as never);
    expect(useSessionStore.getState().planMode).toBe(false);
  });

  it("计划审批重放去重，并按 requestId 解除", () => {
    const store = useSessionStore.getState();
    store.setSession("A");
    const update = {
      sessionUpdate: "plan_approval_request",
      requestId: "r-1",
      sessionId: "A",
      toolCallId: "tc-1",
      planContent: "# Plan",
      __sessionId: "A",
    } as never;
    store.applyUpdate(update);
    store.applyUpdate(update);
    expect(useSessionStore.getState().transcripts.A.planApprovals).toHaveLength(1);
    store.applyUpdate({
      sessionUpdate: "plan_approval_resolved",
      requestId: "r-1",
      __sessionId: "A",
    } as never);
    expect(useSessionStore.getState().planApproval).toBeNull();
  });

  it("切离再切回保留本地 pushUser 的用户消息", () => {
    useSessionStore.getState().setSession("A");
    useSessionStore.getState().pushUser("北京天气怎么样");
    expect(useSessionStore.getState().messages[0].role).toBe("user");

    useSessionStore.getState().setSession("B");
    expect(useSessionStore.getState().messages).toEqual([]);

    useSessionStore.getState().setSession("A");
    expect(useSessionStore.getState().messages[0].role).toBe("user");
    expect(textOf(0)).toBe("北京天气怎么样");
  });

  it("pushUser 保留附件并去重", () => {
    const s = useSessionStore.getState();
    s.setSession("A");
    s.pushUser("请优化", ["/tmp/方案.docx", "/tmp/方案.docx"]);
    expect(useSessionStore.getState().messages[0].attachments).toEqual(["/tmp/方案.docx"]);
  });

  it("后台续发只写入目标会话，不污染当前会话", () => {
    const s = useSessionStore.getState();
    s.setSession("A");
    s.pushUser("A 的历史");
    s.setSession("B");
    s.pushUser("B 的历史");

    s.pushUser("排队续发", ["/tmp/续发.docx"], "A");
    s.startStreaming("A");

    const state = useSessionStore.getState();
    expect(state.sessionId).toBe("B");
    expect(state.streaming).toBe(false);
    expect(state.messages).toHaveLength(1);
    expect(userMessageTextForTest(state.messages[0])).toBe("B 的历史");
    expect(state.transcripts.A.messages.map((message) => message.role)).toEqual([
      "user", "user", "assistant",
    ]);
    expect(userMessageTextForTest(state.transcripts.A.messages[1])).toBe("排队续发");
    expect(state.transcripts.A.messages[1].attachments).toEqual(["/tmp/续发.docx"]);
    expect(state.transcripts.A.streamingMessageId).not.toBeNull();
  });

  it("对异常超长的流式输出设置界面累积上限", () => {
    const s = useSessionStore.getState();
    s.setSession("A");
    s.applyUpdate(chunk("x".repeat(2_000_100), "A"));
    const message = useSessionStore.getState().messages[0];
    const text = message.parts[0] as { kind: "text"; text: string };
    expect(text.text.length).toBeLessThanOrEqual(2_000_000);
    expect(text.text).toContain("输出过大");
  });

  it("在合并多块流式内容时就限制中间字符串大小", () => {
    const s = useSessionStore.getState();
    s.setSession("A");
    s.applyUpdate({
      sessionUpdate: "agent_message_chunk",
      content: [
        { type: "text", text: "a".repeat(1_500_000) },
        { type: "text", text: "b".repeat(1_500_000) },
        { type: "text", text: "c".repeat(1_500_000) },
      ],
      __sessionId: "A",
    } as unknown as Parameters<typeof s.applyUpdate>[0]);

    const message = useSessionStore.getState().messages[0];
    const text = message.parts[0] as { kind: "text"; text: string };
    expect(text.text.length).toBeLessThanOrEqual(2_000_000);
    expect(text.text).toContain("输出过大");
    expect(text.text).not.toContain("c");
  });

  it("历史回放按 promptIndex 恢复用户文本、附件和轮次边界", () => {
    const s = useSessionStore.getState();
    s.setSession("A");
    s.applyUpdate(userChunk({
      type: "text",
      text: "<system-reminder>hidden</system-reminder>\n\nraw body",
      _meta: {
        displayText: "请优化方案",
        echoAgentAttachments: ["/tmp/方案.docx"],
      },
    }, "A", 1));
    s.applyUpdate(userChunk({
      type: "image",
      data: "AAAA",
      mimeType: "image/png",
      uri: "/tmp/架构图.png",
    }, "A", 1));
    s.applyUpdate(chunk("第一轮回答", "A"));
    s.applyUpdate(userChunk({ type: "text", text: "第二轮问题" }, "A", 2));
    s.applyUpdate(chunk("第二轮回答", "A"));
    s.applyUpdate({
      sessionUpdate: "turn_completed",
      __sessionId: "A",
    } as unknown as Parameters<typeof s.applyUpdate>[0]);

    const messages = useSessionStore.getState().messages;
    expect(messages.map((message) => message.role)).toEqual([
      "user", "assistant", "user", "assistant",
    ]);
    expect(userMessageTextForTest(messages[0])).toBe("请优化方案");
    expect(messages[0].attachments).toEqual(["/tmp/方案.docx", "/tmp/架构图.png"]);
    expect(messages[1].complete).toBe(true);
    expect(messages[3].complete).toBe(true);
    expect(useSessionStore.getState().streaming).toBe(false);
  });

  it("实时 user_message_chunk 与乐观消息合并，不产生重复气泡", () => {
    const s = useSessionStore.getState();
    s.setSession("A");
    s.pushUser("请分析文档");
    s.startStreaming();
    s.applyUpdate(userChunk({
      type: "text",
      text: "模型实际文本",
      _meta: {
        displayText: "请分析文档",
        echoAgentAttachments: ["/tmp/report.docx"],
      },
    }, "A", 7));

    const messages = useSessionStore.getState().messages;
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[0].promptIndex).toBe(7);
    expect(messages[0].attachments).toEqual(["/tmp/report.docx"]);
    expect(messages[1].role).toBe("assistant");
  });

  it("旧会话回放可从附件文本后缀恢复文档", () => {
    const s = useSessionStore.getState();
    s.setSession("A");
    s.applyUpdate(userChunk({
      type: "text",
      text: "请检查\n\n附件（图片已作为多模态内容附加；其他文件请使用 read_file 读取）：\n- @/tmp/旧方案.docx",
    }, "A", 1));
    const message = useSessionStore.getState().messages[0];
    expect(userMessageTextForTest(message)).toBe("请检查");
    expect(message.attachments).toEqual(["/tmp/旧方案.docx"]);
  });

  it("历史回放不展示 hideFromScrollback 内部消息", () => {
    const s = useSessionStore.getState();
    s.setSession("A");
    s.applyUpdate({
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "internal wake-up" },
      _meta: { promptIndex: 1, hideFromScrollback: true },
      __sessionId: "A",
    } as unknown as Parameters<typeof s.applyUpdate>[0]);
    expect(useSessionStore.getState().messages).toEqual([]);
  });

  it("流式中切走:后台 update 累积进旧会话 transcript,不污染当前", () => {
    const s = useSessionStore.getState();
    s.setSession("A");
    s.pushUser("q");
    s.startStreaming();
    s.applyUpdate(chunk("part1", "A"));
    expect(useSessionStore.getState().streaming).toBe(true);

    s.setSession("B"); // 切走,A 后台继续
    expect(useSessionStore.getState().messages).toEqual([]);
    expect(useSessionStore.getState().streaming).toBe(false);

    // 后台 chunk 带 __sessionId=A → 进 transcripts[A],绝不能进 B。
    useSessionStore.getState().applyUpdate(chunk("part2", "A"));
    expect(useSessionStore.getState().messages).toEqual([]); // B 仍空
    const a = useSessionStore.getState().transcripts["A"];
    const asst = a.messages.find((m) => m.role === "assistant")!;
    expect(
      asst.parts
        .filter((p) => p.kind === "text")
        .map((p) => (p as { text: string }).text)
        .join(""),
    ).toBe("part1part2");
    expect(a.streamingMessageId).not.toBeNull(); // A 仍在流
  });

  it("后台 complete 路由进旧会话,切回看到完整且已结束", () => {
    const s = useSessionStore.getState();
    s.setSession("A");
    s.pushUser("q");
    s.startStreaming();
    s.applyUpdate(chunk("answer", "A"));
    s.setSession("B");
    s.markComplete(complete("A", 42)); // A 在后台结束

    const a = useSessionStore.getState().transcripts["A"];
    expect(a.streamingMessageId).toBeNull();
    expect(a.messages.find((m) => m.role === "assistant")!.complete).toBe(true);
    expect(a.usage.totalTokens).toBe(42);

    s.setSession("A"); // 切回
    expect(textOf(1)).toBe("answer");
    expect(useSessionStore.getState().streaming).toBe(false);
    expect(useSessionStore.getState().usage.totalTokens).toBe(42);
  });

  it("prompt_complete 保留取消触发器、分类和错误详情", () => {
    const s = useSessionStore.getState();
    s.setSession("A");
    s.startStreaming();
    s.applyUpdate(chunk("partial", "A"));
    s.markComplete({
      sessionId: "A",
      promptId: "p-1",
      stopReason: "cancelled",
      cancelTrigger: "permission",
      cancellationCategory: "PermissionRejected",
      agentResult: "permission denied",
    });

    const assistant = useSessionStore.getState().messages[0];
    expect(assistant).toMatchObject({
      complete: true,
      stopReason: "cancelled",
      cancelTrigger: "permission",
      cancellationCategory: "PermissionRejected",
      agentResult: "permission denied",
    });
  });

  it("sendNow 在旧轮取消和新轮开始之间保持运行态", () => {
    const s = useSessionStore.getState();
    s.setSession("A");
    s.pushUser("原任务");
    s.startStreaming(undefined, "prompt-old");
    s.applyUpdate(chunk("请选择 1/2/3", "A"));
    s.requestSendNow("prompt-new");

    s.markComplete({
      sessionId: "A",
      promptId: "prompt-old",
      stopReason: "cancelled",
      cancelTrigger: "send_now",
    });

    const handoff = useSessionStore.getState();
    expect(handoff.streaming).toBe(true);
    expect(handoff.sendNowPending).toBe(true);
    expect(handoff.streamingMessageId).toBeNull();
    expect(handoff.messages[1]).toMatchObject({
      promptId: "prompt-old",
      complete: true,
      cancelTrigger: "send_now",
    });

    s.applyUpdate(userChunk({ type: "text", text: "2" }, "A", 2));
    const replacement = useSessionStore.getState();
    expect(replacement.messages.map((message) => message.role)).toEqual([
      "user", "assistant", "user", "assistant",
    ]);
    expect(replacement.messages[3]).toMatchObject({
      promptId: "prompt-new",
      complete: false,
    });
    expect(replacement.sendNowPending).toBe(false);
    expect(replacement.streaming).toBe(true);
  });

  it("sendNow 旧轮的迟到重复终态不会关闭新轮", () => {
    const s = useSessionStore.getState();
    s.setSession("A");
    s.pushUser("原任务");
    s.startStreaming(undefined, "prompt-old");
    s.applyUpdate(chunk("partial", "A"));
    s.requestSendNow("prompt-new");
    s.markComplete({
      sessionId: "A",
      promptId: "prompt-old",
      stopReason: "cancelled",
      cancelTrigger: "send_now",
    });
    s.applyUpdate(userChunk({ type: "text", text: "选择 2" }, "A", 2));
    s.applyUpdate(chunk("新任务回复", "A"));

    // Durable replay for the old completion may arrive after new chunks.
    s.applyUpdate({
      sessionUpdate: "turn_completed",
      prompt_id: "prompt-old",
      stop_reason: "cancelled",
      _meta: { cancelTrigger: "send_now" },
      __sessionId: "A",
    } as never);

    expect(useSessionStore.getState().streaming).toBe(true);
    expect(useSessionStore.getState().messages[3]).toMatchObject({
      promptId: "prompt-new",
      complete: false,
    });
    // Legacy duplicate without prompt_id is equally unable to close new work.
    s.applyUpdate({
      sessionUpdate: "turn_completed",
      stop_reason: "cancelled",
      _meta: { cancelTrigger: "send_now" },
      __sessionId: "A",
    } as never);
    expect(useSessionStore.getState().streaming).toBe(true);
    s.markComplete({ sessionId: "A", promptId: "prompt-new", stopReason: "end_turn" });
    expect(useSessionStore.getState().streaming).toBe(false);
    expect(useSessionStore.getState().messages[3].complete).toBe(true);
  });

  it("sendNow 新轮 chunk 先于旧轮终态到达时仍分开两个助手消息", () => {
    const s = useSessionStore.getState();
    s.setSession("A");
    s.pushUser("原任务");
    s.startStreaming(undefined, "prompt-old");
    s.applyUpdate(chunk("旧回复", "A"));
    s.requestSendNow("prompt-new");

    // Defensive ordering: a transport may expose the replacement chunk just
    // before the durable cancellation event for the old prompt.
    s.applyUpdate(chunk("新回复", "A"));
    let state = useSessionStore.getState();
    expect(state.messages.filter((message) => message.role === "assistant")).toHaveLength(2);
    expect(state.messages[1]).toMatchObject({ promptId: "prompt-old", complete: false });
    expect(state.messages[2]).toMatchObject({ promptId: "prompt-new", complete: false });

    s.markComplete({
      sessionId: "A",
      promptId: "prompt-old",
      stopReason: "cancelled",
      cancelTrigger: "send_now",
    });
    state = useSessionStore.getState();
    expect(state.streaming).toBe(true);
    expect(state.messages[1].complete).toBe(true);
    expect(state.messages[2]).toMatchObject({ promptId: "prompt-new", complete: false });
  });

  it("历史 turn_completed 从持久化元数据恢复终止语义", () => {
    const s = useSessionStore.getState();
    s.setSession("A");
    s.startStreaming();
    s.applyUpdate(chunk("partial", "A"));
    s.applyUpdate({
      sessionUpdate: "turn_completed",
      stop_reason: "cancelled",
      agent_result: "stopped by policy",
      _meta: {
        cancelTrigger: "hook",
        cancellationCategory: "HookDenied",
        agentTimestampMs: 123_456,
      },
      __sessionId: "A",
    } as never);

    expect(useSessionStore.getState().messages[0]).toMatchObject({
      complete: true,
      stopReason: "cancelled",
      cancelTrigger: "hook",
      cancellationCategory: "HookDenied",
      agentResult: "stopped by policy",
      completedAt: 123_456,
    });
  });

  it("历史失败在没有助手 chunk 时仍保留可见终止记录", () => {
    const s = useSessionStore.getState();
    s.setSession("A");
    s.applyUpdate({
      sessionUpdate: "turn_completed",
      prompt_id: "p-empty",
      stop_reason: "error",
      agent_result: "connection reset",
      __sessionId: "A",
    } as never);

    expect(useSessionStore.getState().messages).toEqual([
      expect.objectContaining({
        role: "assistant",
        parts: [],
        complete: true,
        promptId: "p-empty",
        stopReason: "error",
        agentResult: "connection reset",
      }),
    ]);
  });

  it("持久终态与 prompt_complete 双轨到达时只保留一条记录", () => {
    const s = useSessionStore.getState();
    s.setSession("A");
    s.startStreaming();
    s.applyUpdate(chunk("partial", "A"));
    s.applyUpdate({
      sessionUpdate: "turn_completed",
      prompt_id: "p-1",
      stop_reason: "error",
      agent_result: "first detail",
      __sessionId: "A",
    } as never);
    s.markComplete({
      sessionId: "A",
      promptId: "p-1",
      stopReason: "error",
      agentResult: "final detail",
    });

    expect(useSessionStore.getState().messages).toHaveLength(1);
    expect(useSessionStore.getState().messages[0]).toMatchObject({
      promptId: "p-1",
      stopReason: "error",
      agentResult: "final detail",
    });
  });

  it("Agent 进程崩溃时终止所有前后台流并清理方案审批", () => {
    const s = useSessionStore.getState();
    s.setSession("A");
    s.startStreaming();
    s.applyUpdate(chunk("A partial", "A"));
    s.requestPlanApproval({
      requestId: "approval-1",
      sessionId: "A",
      toolCallId: "tool-1",
    });
    s.setSession("B");
    s.startStreaming();
    s.applyUpdate(chunk("B partial", "B"));

    s.failAllStreaming("error", "agent crashed");

    const state = useSessionStore.getState();
    expect(state.streaming).toBe(false);
    expect(state.transcripts.A.streamingMessageId).toBeNull();
    expect(state.transcripts.B.streamingMessageId).toBeNull();
    expect(state.transcripts.A.planApprovals).toEqual([]);
    expect(state.transcripts.A.messages[state.transcripts.A.messages.length - 1]?.stopReason)
      .toBe("error");
    expect(state.transcripts.B.messages[state.transcripts.B.messages.length - 1]?.stopReason)
      .toBe("error");
    expect(state.transcripts.A.messages[state.transcripts.A.messages.length - 1]?.agentResult)
      .toBe("agent crashed");
  });

  it("流式中切回(尚未 complete)→ streaming 仍为 true", () => {
    const s = useSessionStore.getState();
    s.setSession("A");
    s.pushUser("q");
    s.startStreaming();
    s.applyUpdate(chunk("so far", "A"));
    s.setSession("B");
    s.applyUpdate(chunk(" more", "A")); // 后台累积,未 complete
    s.setSession("A"); // 切回,A 仍在流
    expect(useSessionStore.getState().streaming).toBe(true);
    expect(textOf(1)).toBe("so far more");
  });

  it("agent_send 拒绝时回滚未提交的用户消息和空助手占位", () => {
    const s = useSessionStore.getState();
    s.setSession("A");
    s.pushUser("请不要丢失");
    s.startStreaming();
    expect(useSessionStore.getState().messages).toHaveLength(2);

    s.rollbackPendingTurn();
    expect(useSessionStore.getState().messages).toEqual([]);
    expect(useSessionStore.getState().streaming).toBe(false);
  });

  it("已有流式内容时不回滚已开始的 turn", () => {
    const s = useSessionStore.getState();
    s.setSession("A");
    s.pushUser("q");
    s.startStreaming();
    s.applyUpdate(chunk("partial", "A"));

    s.rollbackPendingTurn();
    expect(useSessionStore.getState().messages).toHaveLength(2);
    expect(textOf(1)).toBe("partial");
  });

  it("foreign update 无监听也不污染当前会话(路由到各自 transcript)", () => {
    const s = useSessionStore.getState();
    s.setSession("B");
    // 归属 X(无 transcript、无监听)→ 创建 transcripts[X],B 不变。
    s.applyUpdate(chunk("stray", "X"));
    expect(useSessionStore.getState().messages).toEqual([]);
    expect(useSessionStore.getState().transcripts["X"].messages.length).toBe(1);
  });

  it("缓存命中时屏蔽回放 update;clearReplaySuppression 后恢复", () => {
    const s = useSessionStore.getState();
    s.setSession("A");
    s.pushUser("q");
    s.applyUpdate(chunk("real", "A"));
    s.setSession("B");
    s.setSession("A"); // 命中缓存 → suppressReplay=true
    expect(useSessionStore.getState().transcripts["A"].suppressReplay).toBe(
      true,
    );

    // 回放重发的历史 chunk 必须被丢弃,不能合并/重复。
    s.applyUpdate(chunk("REPLAYED", "A"));
    expect(textOf(1)).toBe("real");

    // load 结束后清除抑制,真正的新一轮 update 才能进入。
    s.clearReplaySuppression("A");
    s.applyUpdate(chunk("LIVE", "A"));
    expect(textOf(1)).toBe("realLIVE");
  });

  it("stopStreaming 保留已流出内容并清 streaming 标志", () => {
    const s = useSessionStore.getState();
    s.setSession("A");
    s.pushUser("q");
    s.startStreaming();
    s.applyUpdate(chunk("partial", "A"));
    expect(useSessionStore.getState().streaming).toBe(true);

    s.stopStreaming();
    expect(useSessionStore.getState().streaming).toBe(false);
    expect(useSessionStore.getState().streamingMessageId).toBeNull();
    // 已流出的文本保留,且该 assistant 消息被标记 complete。
    expect(textOf(1)).toBe("partial");
    expect(useSessionStore.getState().messages[1].complete).toBe(true);
    expect(useSessionStore.getState().messages[1].startedAt).toEqual(expect.any(Number));
    expect(useSessionStore.getState().messages[1].completedAt).toEqual(expect.any(Number));
    expect(useSessionStore.getState().messages[1].stopReason).toBe("cancelled");
  });

  it("错误提示不伪造终态，流式只由真实生命周期事件结束", () => {
    const s = useSessionStore.getState();
    s.setSession("A");
    s.startStreaming();
    s.applyUpdate(chunk("still running", "A"));

    s.setError("停止请求失败");

    expect(useSessionStore.getState().error).toBe("停止请求失败");
    expect(useSessionStore.getState().streaming).toBe(true);
    expect(useSessionStore.getState().messages[0].complete).toBe(false);
  });

  it("stopStreaming 按 sessionId 终止后台会话，不污染当前会话", () => {
    const s = useSessionStore.getState();
    s.setSession("A");
    s.pushUser("A question");
    s.startStreaming();
    s.applyUpdate(chunk("A partial", "A"));
    s.setSession("B");
    s.pushUser("B question");
    s.startStreaming();
    s.applyUpdate(chunk("B partial", "B"));

    s.stopStreaming("A");

    const state = useSessionStore.getState();
    expect(state.transcripts.A.streamingMessageId).toBeNull();
    expect(state.transcripts.B.streamingMessageId).not.toBeNull();
    expect(state.sessionId).toBe("B");
    expect(state.streaming).toBe(true);
  });

  it("dropSessionCache 后切回走空(交给回放重建)", () => {
    const s = useSessionStore.getState();
    s.setSession("A");
    s.pushUser("q");
    s.applyUpdate(chunk("x", "A"));
    s.setSession("B");
    s.dropSessionCache("A");
    expect(useSessionStore.getState().transcripts["A"]).toBeUndefined();
    s.setSession("A"); // 无缓存 → 空,不抑制
    expect(useSessionStore.getState().messages).toEqual([]);
    expect(useSessionStore.getState().transcripts["A"].suppressReplay).toBe(
      false,
    );
  });
});

describe("tool_call content 归一化 (normalizeToolCallContent)", () => {
  beforeEach(resetStore);

  /** 注入一条 tool_call update,返回生成的 ToolCallView。 */
  const applyToolCall = (content: unknown) => {
    const s = useSessionStore.getState();
    s.setSession("A");
    s.applyUpdate(
      {
        sessionUpdate: "tool_call",
        toolCallId: "tc-1",
        title: "Read foo.png",
        kind: "read_file",
        status: "completed",
        content,
        __sessionId: "A",
      } as unknown as Parameters<
        ReturnType<typeof useSessionStore.getState>["applyUpdate"]
      >[0],
    );
    const msg = useSessionStore
      .getState()
      .messages.find((m) => m.role === "assistant")!;
    const part = msg.parts.find((p) => p.kind === "tool_call")! as unknown as {
      toolCall: { content: Record<string, unknown>[] };
    };
    return part.toolCall.content;
  };

  it("ACP image content(EchoAgent read_file 读图片/PDF)→ 前端 image 块", () => {
    const out = applyToolCall([
      {
        type: "content",
        content: { type: "image", data: "aGVsbG8=", mimeType: "image/png", uri: "file:///tmp/foo.png" },
      },
    ]);
    expect(out).toEqual([
      { type: "image", data: "aGVsbG8=", mimeType: "image/png", uri: "file:///tmp/foo.png" },
    ]);
  });

  it("多页 PDF 的多个 image 块都保留顺序", () => {
    const out = applyToolCall([
      { type: "content", content: { type: "image", data: "AAAA", mimeType: "image/png" } },
      { type: "content", content: { type: "image", data: "BBBB", mimeType: "image/jpeg" } },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ type: "image", data: "AAAA", mimeType: "image/png", uri: undefined });
    expect(out[1].mimeType).toBe("image/jpeg");
  });

  it("resource_link 降级为 name+uri 文本,不再静默丢失", () => {
    const out = applyToolCall([
      { type: "content", content: { type: "resource_link", name: "报告", uri: "file:///tmp/r.md" } },
    ]);
    expect(out).toEqual([{ type: "text", text: "报告\nfile:///tmp/r.md" }]);
  });

  it("embedded resource 的 text 内容被提取", () => {
    const out = applyToolCall([
      { type: "content", content: { type: "resource", resource: { uri: "file:///x", text: "inline" } } },
    ]);
    expect(out).toEqual([{ type: "text", text: "inline" }]);
  });

  it("ACP diff(oldText/newText 扁平)→ 嵌套 diff.old/new", () => {
    const out = applyToolCall([
      { type: "diff", path: "a.txt", oldText: "1", newText: "2" },
    ]);
    expect(out).toEqual([{ type: "diff", diff: { path: "a.txt", old: "1", new: "2" } }]);
  });

  it("terminal → command_output 占位(保持旧行为)", () => {
    const out = applyToolCall([{ type: "terminal", terminalId: "t1" }]);
    expect(out).toEqual([{ type: "command_output", command: undefined, output: "[terminal t1]" }]);
  });

  it("工具输出块数有上限，避免恶意 MCP 卡死界面", () => {
    const out = applyToolCall(Array.from({ length: 300 }, (_, index) => ({
      type: "content",
      content: { type: "text", text: String(index) },
    })));
    expect(out).toHaveLength(256);
    expect(out[255]).toEqual({ type: "text", text: "255" });
  });
});
