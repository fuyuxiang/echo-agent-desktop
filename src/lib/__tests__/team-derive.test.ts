import { describe, it, expect } from "vitest";
import { deriveTeams, isCreateTeamTool, latestTeamAttempts, teamStats } from "../team-derive";
import type { ChatMessage } from "@/stores/session-store";

function teamMsg(
  toolCallId: string,
  teamId: string,
  members: Array<{ name: string; role: string }>,
  status: "in_progress" | "completed" | "failed",
): ChatMessage {
  return {
    id: toolCallId,
    role: "assistant",
    complete: true,
    parts: [
      {
        kind: "tool_call",
        toolCall: {
          toolCallId,
          title: "create_team",
          kind: "create_team",
          status,
          content: [],
          rawInput: { team_id: teamId, members },
        },
      },
    ],
  };
}

describe("isCreateTeamTool", () => {
  it.each(["创建专家团", "创建团队"])("兼容只有 %s 标题的工具记录", (title) => {
    expect(isCreateTeamTool({ kind: "other", title, toolCallId: "legacy-title" })).toBe(true);
  });
  it("kind=create_team 命中", () => {
    expect(
      isCreateTeamTool({ kind: "create_team", title: "", toolCallId: "x" }),
    ).toBe(true);
  });
  it("rawInput 带 team_id + members 命中", () => {
    expect(
      isCreateTeamTool({
        kind: "other",
        title: "",
        toolCallId: "x",
        rawInput: { team_id: "t", members: [] },
      }),
    ).toBe(true);
  });
  it("识别 MCP 调度包装并解析真实成员", () => {
    const message = teamMsg("wrapped", "a", [], "in_progress");
    const part = message.parts[0];
    if (part.kind !== "tool_call") throw new Error("fixture");
    part.toolCall.kind = "use_tool";
    part.toolCall.title = "use_tool";
    part.toolCall.rawInput = { tool_name: "echoagent__create_team", tool_input: { team_id: "123", members: [{ name: "代码专家", role: "实现" }] } };
    expect(isCreateTeamTool(part.toolCall)).toBe(true);
    expect(deriveTeams([message])[0]).toMatchObject({ teamId: "123", members: ["代码专家"] });
  });
  it("普通工具不命中", () => {
    expect(
      isCreateTeamTool({ kind: "edit", title: "Edit", toolCallId: "x" }),
    ).toBe(false);
  });
});

describe("deriveTeams", () => {
  it("从 create_team tool_call 派生团队与成员", () => {
    const list = deriveTeams([
      teamMsg("t1", "sw-team", [
        { name: "architect", role: "架构" },
        { name: "coder", role: "编码" },
      ], "completed"),
    ]);
    expect(list).toHaveLength(1);
    expect(list[0].teamId).toBe("sw-team");
    expect(list[0].members).toEqual(["architect", "coder"]);
    expect(list[0].status).toBe("completed");
  });
  it("忽略非 create_team 工具调用", () => {
    const other: ChatMessage = {
      id: "o1",
      role: "assistant",
      complete: true,
      parts: [
        {
          kind: "tool_call",
          toolCall: {
            toolCallId: "o1",
            title: "Edit x",
            kind: "edit",
            status: "completed",
            content: [],
          },
        },
      ],
    };
    expect(deriveTeams([other])).toEqual([]);
  });
  it("同 toolCallId 去重", () => {
    const msg = teamMsg("t1", "a", [{ name: "m1", role: "r" }], "completed");
    expect(deriveTeams([msg, msg])).toHaveLength(1);
  });
  it("多团队保持顺序", () => {
    expect(
      deriveTeams([
        teamMsg("t1", "team-a", [{ name: "x", role: "r" }], "completed"),
        teamMsg("t2", "team-b", [{ name: "y", role: "r" }], "in_progress"),
      ]).map((t) => t.teamId),
    ).toEqual(["team-a", "team-b"]);
  });
  it("空消息返回空", () => {
    expect(deriveTeams([])).toEqual([]);
  });
  it("成员名是字符串也能解析", () => {
    const msg: ChatMessage = {
      id: "t1",
      role: "assistant",
      complete: true,
      parts: [
        {
          kind: "tool_call",
          toolCall: {
            toolCallId: "t1",
            title: "create_team",
            kind: "create_team",
            status: "completed",
            content: [],
            rawInput: { team_id: "t", members: ["alice", "bob"] },
          },
        },
      ],
    };
    expect(deriveTeams([msg])[0].members).toEqual(["alice", "bob"]);
  });

  it.each([
    { name: "代码专家", role: "分析" },
    JSON.stringify([{ name: "代码专家", role: "分析" }]),
  ])("对话工具的兼容成员格式与后端一致", (members) => {
    const message = teamMsg("wrapped", "discuss", [], "completed");
    const part = message.parts[0];
    if (part.kind !== "tool_call") throw new Error("fixture");
    part.toolCall.kind = "use_tool";
    part.toolCall.title = "use_tool";
    part.toolCall.rawInput = JSON.stringify({ tool_name: "echoagent__create_team", tool_input: { team_id: "discuss", members } });
    expect(isCreateTeamTool(part.toolCall)).toBe(true);
    expect(deriveTeams([message])[0]).toMatchObject({ teamId: "discuss", members: ["代码专家"] });
  });

  it("失败原因来自工具输出，成功调用不会继承旧错误", () => {
    const message = teamMsg("failed", "discuss", [], "failed");
    const part = message.parts[0];
    if (part.kind !== "tool_call") throw new Error("fixture");
    part.toolCall.content = [{ type: "text", text: "members[0]: missing field `role`" }];
    expect(deriveTeams([message])[0].error).toBe("members[0]: missing field `role`");
    part.toolCall.status = "completed";
    expect(deriveTeams([message])[0].error).toBeUndefined();
  });
});

describe("latestTeamAttempts", () => {
  it("按后端的首尾空白规则识别同一团队，保留大小写和未命名调用的区别", () => {
    const messages = [
      teamMsg("first", " \u0085\u3000review-team\u00a0\n", [], "failed"),
      teamMsg("retry", "review-team", [], "in_progress"),
      teamMsg("different-case", "Review-team", [], "failed"),
      teamMsg("unknown-a", " \u3000", [], "failed"),
      teamMsg("unknown-b", "", [], "failed"),
      // BOM is not Unicode White_Space and the backend preserves it.
      teamMsg("different-bom", "\ufeffreview-team", [], "failed"),
    ];
    expect(latestTeamAttempts(deriveTeams(messages))).toMatchObject([
      { id: "retry", teamId: "review-team", status: "in_progress", attempts: 2 },
      { id: "different-case", teamId: "Review-team", attempts: 1 },
      { id: "unknown-a", teamId: "", attempts: 1 },
      { id: "unknown-b", teamId: "", attempts: 1 },
      { id: "different-bom", teamId: "\ufeffreview-team", attempts: 1 },
    ]);
    const original = messages[0].parts[0];
    if (original.kind !== "tool_call") throw new Error("fixture");
    expect(original.toolCall.rawInput).toMatchObject({ team_id: " \u0085\u3000review-team\u00a0\n" });
  });

  it("同一团队的重复失败只保留最新原因，并保留独立团队", () => {
    const attempts = deriveTeams([
      teamMsg("first", "discuss", [], "failed"),
      teamMsg("other", "other", [], "failed"),
      teamMsg("retry", "discuss", [], "failed"),
    ]);
    attempts[0].error = "旧错误";
    attempts[2].error = "新错误";
    expect(latestTeamAttempts(attempts)).toMatchObject([
      { id: "retry", teamId: "discuss", error: "新错误", attempts: 2 },
      { id: "other", teamId: "other", attempts: 1 },
    ]);
    expect(attempts).toHaveLength(3);
  });

  it("进行中和成功的重试会覆盖旧失败，未命名调用分别保留", () => {
    const attempts = deriveTeams([
      teamMsg("first", "discuss", [], "failed"),
      teamMsg("retry", "discuss", [], "in_progress"),
    ]);
    expect(latestTeamAttempts(attempts)[0]).toMatchObject({ status: "in_progress", attempts: 2 });
    attempts.push(...deriveTeams([teamMsg("success", "discuss", [], "completed")]));
    expect(latestTeamAttempts(attempts)[0]).toMatchObject({ status: "completed", attempts: 3 });
    expect(latestTeamAttempts(deriveTeams([
      teamMsg("unknown-a", "", [], "failed"), teamMsg("unknown-b", "", [], "failed"),
    ]))).toHaveLength(2);
  });
});

describe("teamStats", () => {
  it("统计团队数与成员数", () => {
    const s = teamStats([
      { id: "1", teamId: "a", members: ["x", "y"], status: "completed" },
      { id: "2", teamId: "b", members: ["z"], status: "in_progress" },
    ]);
    expect(s).toEqual({ teamCount: 2, memberCount: 3 });
  });
  it("空列表", () => {
    expect(teamStats([])).toEqual({ teamCount: 0, memberCount: 0 });
  });
});
