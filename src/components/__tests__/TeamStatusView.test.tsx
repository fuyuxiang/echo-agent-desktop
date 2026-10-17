import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TeamStatusView } from "../TeamStatusView";
import { agentsList, onTeamsChanged, teamCreate, teamDisband, teamSnapshot } from "@/lib/agent-client";
import { useSubagentStore } from "@/stores/subagent-store";
import type { ChatMessage } from "@/stores/session-store";
import { useGroupStore } from "@/features/groups/group-store";
import type { Group } from "@/features/groups/group-client";

const teamMessage = (status: "in_progress" | "completed"): ChatMessage => ({
  id: "assistant-team", role: "assistant", complete: status === "completed",
  parts: [{ kind: "tool_call", toolCall: {
    toolCallId: "create-team", kind: "echoagent__create_team", title: "创建任务编组", status,
    rawInput: { team_id: "release-team", members: ["planner"] }, content: [],
  } }],
});

vi.mock("@/lib/agent-client", () => ({ teamSnapshot: vi.fn(), agentsList: vi.fn(), teamCreate: vi.fn(), teamDisband: vi.fn(), onTeamsChanged: vi.fn() }));

describe("TeamStatusView", () => {
  beforeEach(() => {
    vi.mocked(teamSnapshot).mockReset();
    vi.mocked(onTeamsChanged).mockResolvedValue(() => {});
    vi.mocked(teamCreate).mockReset().mockResolvedValue(undefined);
    vi.mocked(teamDisband).mockReset().mockResolvedValue(undefined);
    vi.mocked(agentsList).mockReset().mockResolvedValue([
      { name: "代码专家", scope: "user", path: "/agents/代码专家.md", raw: "", description: "实现代码", modelTags: [] },
      { name: "文档助手", scope: "user", path: "/agents/文档助手.md", raw: "", description: "编写文档", modelTags: [] },
    ]);
    useSubagentStore.setState({ bySession: {} });
    useGroupStore.setState({groups:[]});
  });

  it("从持久化运行时快照展示真实专家团", async () => {
    vi.mocked(teamSnapshot).mockResolvedValue([{
      teamId: "release-team",
      members: ["planner", "reviewer"],
      createdAt: 10,
    }]);
    render(<TeamStatusView sessionId="session-a" messages={[]} />);
    expect(await screen.findByText("release-team")).toBeInTheDocument();
    expect(screen.getByText("planner")).toBeInTheDocument();
    expect(screen.getByText("1 个 · 2 名成员")).toBeInTheDocument();
  });

  it("无专家团时给出明确空状态", async () => {
    vi.mocked(teamSnapshot).mockResolvedValue([]);
    render(<TeamStatusView sessionId="session-a" messages={[]} />);
    expect(await screen.findByText(/本会话还没有任务编组/)).toBeInTheDocument();
    expect(teamSnapshot).toHaveBeenCalledWith("session-a");
  });

  it("区分创建独立专家团和打开已关联记录，归档记录也可打开", async () => {
    const team={teamId:"delivery",members:["代码专家"],createdAt:1};
    vi.mocked(teamSnapshot).mockResolvedValue([team]);
    const open=vi.fn(); render(<TeamStatusView sessionId="source" onOpenGroup={open} />);
    const create=await screen.findByRole("button",{name:"以此编组创建专家团"});
    fireEvent.click(create); expect(open).toHaveBeenCalledWith(team);
    act(()=>useGroupStore.setState({groups:[{id:"linked",sourceSessionId:"source",sourceTeamId:"delivery",archived:true} as Group]}));
    expect(screen.queryByRole("button",{name:"以此编组创建专家团"})).toBeNull();
    expect(screen.getByRole("button",{name:"打开专家团"})).toBeEnabled();
  });

  it("普通文本流式更新不重复读取专家团，专家团工具状态变更会刷新", async () => {
    vi.mocked(teamSnapshot).mockResolvedValue([]);
    const { rerender } = render(<TeamStatusView sessionId="session-a" messages={[]} />);
    await waitFor(() => expect(teamSnapshot).toHaveBeenCalledTimes(1));
    for (let index = 1; index <= 5; index += 1) {
      rerender(<TeamStatusView sessionId="session-a" messages={[{ id: "assistant", role: "assistant", complete: false, parts: [{ kind: "text", text: "输出".repeat(index) }] }]} />);
    }
    expect(teamSnapshot).toHaveBeenCalledTimes(1);
    rerender(<TeamStatusView sessionId="session-a" messages={[teamMessage("in_progress")]} />);
    await waitFor(() => expect(teamSnapshot).toHaveBeenCalledTimes(2));
    rerender(<TeamStatusView sessionId="session-a" messages={[teamMessage("completed")]} />);
    await waitFor(() => expect(teamSnapshot).toHaveBeenCalledTimes(3));
  });

  it("忽略比新快照更晚返回的旧快照", async () => {
    const finishes: Array<(snapshot: Awaited<ReturnType<typeof teamSnapshot>>) => void> = [];
    vi.mocked(teamSnapshot).mockImplementation(() => new Promise((resolve) => { finishes.push(resolve); }));
    const { rerender } = render(<TeamStatusView sessionId="session-a" messages={[]} />);
    expect(screen.getByRole("status")).toHaveTextContent("正在读取任务编组状态");
    rerender(<TeamStatusView sessionId="session-a" messages={[teamMessage("completed")]} />);
    await act(async () => finishes[1]([{ teamId: "新专家团", members: ["new"], createdAt: 20 }]));
    await act(async () => finishes[0]([{ teamId: "旧专家团", members: ["old"], createdAt: 10 }]));
    expect(screen.getByText("新专家团")).toBeInTheDocument();
    expect(screen.queryByText("旧专家团")).not.toBeInTheDocument();
  });

  it("已有快照后刷新失败保留专家团并显示错误，支持再试", async () => {
    vi.mocked(teamSnapshot)
      .mockResolvedValueOnce([{ teamId: "保留专家团", members: ["planner"], createdAt: 10 }])
      .mockRejectedValueOnce(new Error("暂时读取失败"))
      .mockResolvedValueOnce([]);
    render(<TeamStatusView sessionId="session-a" messages={[]} />);
    expect(await screen.findByText("保留专家团")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("已保留上次结果");
    expect(screen.getByText("保留专家团")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(await screen.findByText(/本会话还没有任务编组/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("手动创建前校验选择，失败时保留表单并允许重试", async () => {
    vi.mocked(teamSnapshot).mockResolvedValue([]);
    vi.mocked(teamCreate).mockRejectedValueOnce(new Error("成员暂不可用")).mockResolvedValueOnce(undefined);
    render(<TeamStatusView sessionId="session-a" />);
    await screen.findByText(/本会话还没有任务编组/);
    fireEvent.click(screen.getByRole("button", { name: "创建任务编组" }));
    await screen.findByRole("checkbox", { name: "代码专家" });
    const name = screen.getByRole("textbox", { name: "任务编组名称" });
    fireEvent.change(name, { target: { value: "交付组" } });
    expect(screen.getByRole("button", { name: "确认创建" })).toBeDisabled();
    fireEvent.click(await screen.findByRole("checkbox", { name: "代码专家" }));
    fireEvent.click(screen.getByRole("button", { name: "确认创建" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("成员暂不可用");
    expect(name).toHaveValue("交付组");
    vi.mocked(teamSnapshot).mockResolvedValue([{ teamId: "交付组", members: ["代码专家"], createdAt: 1 }]);
    fireEvent.click(screen.getByRole("button", { name: "确认创建" }));
    expect(await screen.findByText("待派发任务")).toBeInTheDocument();
    expect(teamCreate).toHaveBeenLastCalledWith("session-a", { team_id: "交付组", members: [{ name: "代码专家", role: "实现代码" }], description: undefined });
  });

  it("解散需要确认且传递当前会话，失败可再次提交", async () => {
    vi.mocked(teamSnapshot).mockResolvedValue([{ teamId: "交付组", members: ["代码专家"], createdAt: 1 }]);
    vi.mocked(teamDisband).mockRejectedValueOnce(new Error("保存失败")).mockResolvedValueOnce(undefined);
    render(<TeamStatusView sessionId="session-a" />);
    await screen.findByText("交付组");
    fireEvent.click(screen.getByRole("button", { name: "解散任务编组" }));
    expect(teamDisband).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认解散" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("保存失败");
    vi.mocked(teamSnapshot).mockResolvedValue([]);
    fireEvent.click(screen.getByRole("button", { name: "确认解散" }));
    await screen.findByText(/本会话还没有任务编组/);
    expect(teamDisband).toHaveBeenCalledWith("session-a", "交付组");
  });

  it("切换会话后立即隐藏旧专家团，并忽略旧请求和旧事件", async () => {
    let notify: ((session: string) => void) | undefined;
    vi.mocked(onTeamsChanged).mockImplementation(async (callback) => { notify = callback; return () => {}; });
    vi.mocked(teamSnapshot).mockResolvedValueOnce([{ teamId: "A专家团", members: ["a"], createdAt: 1 }]).mockResolvedValue([]);
    const { rerender } = render(<TeamStatusView sessionId="session-a" />);
    await screen.findByText("A专家团");
    rerender(<TeamStatusView sessionId="session-b" />);
    expect(screen.queryByText("A专家团")).not.toBeInTheDocument();
    await screen.findByText(/本会话还没有任务编组/);
    const calls = vi.mocked(teamSnapshot).mock.calls.length;
    act(() => notify?.("session-a"));
    expect(teamSnapshot).toHaveBeenCalledTimes(calls);
    act(() => notify?.("session-b"));
    await waitFor(() => expect(teamSnapshot).toHaveBeenCalledTimes(calls + 1));
    expect(teamSnapshot).toHaveBeenLastCalledWith("session-b");
  });

  it("依据真实生命周期显示成员进度，不把已登记当作执行完成", async () => {
    vi.mocked(teamSnapshot).mockResolvedValue([{ teamId: "交付组", members: ["代码专家", "文档助手"], createdAt: 1, promptIds: ["prompt-1"] }]);
    render(<TeamStatusView sessionId="session-a" />);
    await screen.findByText("待派发任务");
    act(() => useSubagentStore.getState().applyEvent({ sessionId: "session-a", phase: "spawned", subagentId: "child", subagentType: "代码专家", parentPromptId: "prompt-1" }));
    expect(screen.getAllByText("执行中")).toHaveLength(2);
    act(() => useSubagentStore.getState().applyEvent({ sessionId: "session-a", phase: "finished", subagentId: "child", status: "failed", error: "执行失败" }));
    expect(screen.getByText("有任务未完成")).toBeInTheDocument();
    expect(screen.getByText("待派发")).toBeInTheDocument();
  });

  it.each(["任务编组", "专家团", "团队", "专家团队"])("恢复使用%s称呼的历史编组，预选原请求中的全部现有专家", async (label) => {
    vi.mocked(teamSnapshot).mockResolvedValue([]);
    const messages: ChatMessage[] = [
      { id: "user", role: "user", complete: true, parts: [{ kind: "text", text: `请用代码专家、文档助手创建${label}123，生成代码和文档` }] },
      { id: "assistant", role: "assistant", complete: true, parts: [{ kind: "tool_call", toolCall: { toolCallId: "spawn", kind: "spawn_subagent", title: "任务", status: "completed", content: [], rawInput: { subagent_type: "代码专家", description: "生成代码" } } }] },
    ];
    render(<TeamStatusView sessionId="session-a" messages={messages} />);
    fireEvent.click(await screen.findByRole("button", { name: "恢复任务编组“123”" }));
    expect(await screen.findByRole("checkbox", { name: "文档助手" })).toBeChecked();
    expect(screen.getByRole("textbox", { name: "任务编组名称" })).toHaveValue("123");
  });

});
