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

const resetStore = () =>
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
});
