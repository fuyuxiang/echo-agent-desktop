import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { Plan } from "@/lib/types";
import { useSessionStore } from "@/stores/session-store";

// vi.mock 工厂被提升,引用的变量必须用 vi.hoisted 声明。
const { mocks } = vi.hoisted(() => ({
  mocks: {
    capturedPlan: null as Plan | null,
    setPlan: (..._a: unknown[]) => {},
    togglePlanMode: (..._a: unknown[]) => {},
    resolvePlanApproval: vi.fn(),
    planApproval: null as null | {
      requestId: string;
      sessionId: string;
      toolCallId: string;
      planContent?: string;
    },
  },
}));

vi.mock("@/lib/agent-client", () => ({
  setPlanMode: (...args: unknown[]) => mocks.togglePlanMode(...args),
  agentResolvePlanApproval: mocks.resolvePlanApproval,
}));

import { PlanPanel } from "../PlanPanel";

// 用真实 vi.fn 绑定到 mocks 上(在 import 之后)。
const originalSetPlan = useSessionStore.getState().setPlan;
const setPlan = vi.fn((p: Plan | null, options?: Parameters<typeof originalSetPlan>[1]) => {
  mocks.capturedPlan = p;
  originalSetPlan(p, options);
});
const togglePlanMode = vi.fn();
mocks.setPlan = setPlan as unknown as typeof mocks.setPlan;
mocks.togglePlanMode = togglePlanMode as unknown as typeof mocks.togglePlanMode;
const capturedPlan = () => mocks.capturedPlan;
const initialPlan = (): Plan => ({
  entries: [
    { content: "步骤一", priority: "high", status: "completed" },
    { content: "步骤二", priority: "medium", status: "in_progress" },
    { content: "步骤三", priority: "low", status: "pending" },
  ],
});
const focusSession = (sessionId: string) => {
  const store = useSessionStore.getState();
  store.setSession(sessionId);
  store.clearReplaySuppression(sessionId);
  if (!useSessionStore.getState().plan) originalSetPlan(initialPlan());
};

describe("PlanPanel 编辑器(对齐 EchoAgent plan-editor)", () => {
  beforeEach(() => {
    setPlan.mockClear();
    mocks.capturedPlan = null;
    togglePlanMode.mockReset();
    mocks.resolvePlanApproval.mockReset();
    mocks.planApproval = null;
    useSessionStore.getState().reset();
    useSessionStore.setState({ transcripts: {}, setPlan });
    focusSession("s1");
  });

  it("渲染进度与列表", () => {
    render(<PlanPanel sessionId="s1" />);
    expect(screen.getByText("1/3")).toBeInTheDocument();
    expect(screen.getByText("步骤一")).toBeInTheDocument();
    expect(screen.getByText("步骤三")).toBeInTheDocument();
  });

  it("上移/下移按钮调用 setPlan(reorder)", () => {
    render(<PlanPanel sessionId="s1" />);
    const ups = screen.getAllByRole("button", { name: "上移" });
    const downs = screen.getAllByRole("button", { name: "下移" });
    // 第二条上移 → [二, 一, 三]
    fireEvent.click(ups[1]);
    expect(setPlan).toHaveBeenCalled();
    expect(capturedPlan()!.entries.map((e) => e.content)).toEqual([
      "步骤二",
      "步骤一",
      "步骤三",
    ]);
    // 第一条不能上移(disabled)。
    expect(ups[0]).toBeDisabled();
    // 最后一条不能下移(disabled)。
    expect(downs[2]).toBeDisabled();
  });

  it("点击状态标签循环状态", () => {
    render(<PlanPanel sessionId="s1" />);
    // 第三条状态「待处理」→ 点击 → in_progress
    const statuses = screen.getAllByText("待处理");
    fireEvent.click(statuses[0]);
    expect(capturedPlan()!.entries[2].status).toBe("in_progress");
  });

  it("新增步骤:输入 + Enter 追加 pending 步骤", () => {
    render(<PlanPanel sessionId="s1" />);
    const input = screen.getByPlaceholderText("新增一个步骤…");
    fireEvent.change(input, { target: { value: "步骤四" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(capturedPlan()!.entries).toHaveLength(4);
    expect(capturedPlan()!.entries[3]).toEqual({
      content: "步骤四",
      priority: "medium",
      status: "pending",
    });
  });

  it("新增步骤按钮 disabled 当输入为空", () => {
    render(<PlanPanel sessionId="s1" />);
    expect(screen.getByText("添加").closest("button")).toBeDisabled();
  });

  it("删除按钮调用 setPlan(remove)", () => {
    render(<PlanPanel sessionId="s1" />);
    const dels = screen.getAllByRole("button", { name: "删除此任务" });
    fireEvent.click(dels[0]);
    expect(capturedPlan()!.entries.map((e) => e.content)).toEqual([
      "步骤二",
      "步骤三",
    ]);
  });

  it("运行时已批准但工作流保存失败时立即触发止损", async () => {
    mocks.planApproval = {
      requestId: "approval-1",
      sessionId: "s1",
      toolCallId: "tool-1",
      planContent: "# Plan",
    };
    useSessionStore.getState().requestPlanApproval(mocks.planApproval);
    mocks.resolvePlanApproval.mockResolvedValue(true);
    const onApprovalResolved = vi.fn(async () => {
      throw new Error("保存失败");
    });
    const onApprovalSyncFailed = vi.fn();
    render(
      <PlanPanel
        sessionId="s1"
        onApprovalResolved={onApprovalResolved}
        onApprovalSyncFailed={onApprovalSyncFailed}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "批准执行" }));
    await waitFor(() => expect(onApprovalSyncFailed).toHaveBeenCalledWith("保存失败"));
  });

  it("已编辑的待审批计划先提交修订再等待重新审批，不批准旧计划或伪清同步标记", async () => {
    useSessionStore.getState().requestPlanApproval({ requestId: "approval-edit", sessionId: "s1", toolCallId: "tool-edit" });
    mocks.resolvePlanApproval.mockResolvedValue(true);
    const onToast = vi.fn();
    const onApprovalResolved = vi.fn();
    render(<PlanPanel sessionId="s1" onToast={onToast} onApprovalResolved={onApprovalResolved} />);
    fireEvent.doubleClick(screen.getByText("步骤一"));
    fireEvent.change(screen.getByDisplayValue("步骤一"), { target: { value: "修订后先做安全检查" } });
    fireEvent.keyDown(screen.getByDisplayValue("修订后先做安全检查"), { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: /^(批准执行|同步修改并重新审批)$/ }));

    await waitFor(() => expect(mocks.resolvePlanApproval).toHaveBeenCalledWith(
      "approval-edit", "cancelled", expect.stringContaining("修订后先做安全检查"),
    ));
    expect(mocks.resolvePlanApproval.mock.calls[0][2]).toContain("暂不要开始新步骤");
    expect(onApprovalResolved).toHaveBeenCalledWith("cancelled", expect.arrayContaining(["修订后先做安全检查"]));
    expect(useSessionStore.getState().transcripts.s1.planRevisionDirty).toBe(true);
    expect(useSessionStore.getState().transcripts.s1.plan?.entries[0].content).toBe("修订后先做安全检查");
    expect(onToast).toHaveBeenCalledWith(expect.stringContaining("重新审批"));
    expect(useSessionStore.getState().transcripts.s1.planApprovals).toHaveLength(0);
  });

  it("修订提交未获后端确认时保留草稿和原审批，恢复后用同一请求重试", async () => {
    useSessionStore.getState().requestPlanApproval({ requestId: "approval-retry", sessionId: "s1", toolCallId: "tool-retry" });
    mocks.resolvePlanApproval.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const onToast = vi.fn();
    render(<PlanPanel sessionId="s1" onToast={onToast} />);
    fireEvent.change(screen.getByRole("textbox", { name: "新增步骤" }), { target: { value: "审批前新增复核" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    fireEvent.click(screen.getByRole("button", { name: /^(批准执行|同步修改并重新审批)$/ }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("后端未找到"));
    expect(onToast).toHaveBeenCalledWith(expect.stringContaining("审批失败：后端未找到"));
    expect(useSessionStore.getState().transcripts.s1.planApprovals[0].requestId).toBe("approval-retry");
    expect(useSessionStore.getState().transcripts.s1.planRevisionDirty).toBe(true);
    expect(screen.getByText("审批前新增复核")).toBeInTheDocument();
    expect(mocks.resolvePlanApproval.mock.calls[0][1]).toBe("cancelled");
    fireEvent.click(screen.getByRole("button", { name: /^(批准执行|同步修改并重新审批)$/ }));
    await waitFor(() => expect(useSessionStore.getState().transcripts.s1.planApprovals).toHaveLength(0));
    expect(mocks.resolvePlanApproval).toHaveBeenNthCalledWith(
      2, "approval-retry", "cancelled", expect.stringContaining("审批前新增复核"),
    );
    expect(useSessionStore.getState().transcripts.s1.planRevisionDirty).toBe(true);
  });

  it("已送修订的旧审批晚到成功不污染新会话，原会话新编辑仍未同步", async () => {
    useSessionStore.getState().requestPlanApproval({ requestId: "approval-late", sessionId: "s1", toolCallId: "tool-late" });
    let acknowledge!: (accepted: boolean) => void;
    mocks.resolvePlanApproval.mockImplementationOnce(() => new Promise<boolean>((resolve) => { acknowledge = resolve; }));
    const onToast = vi.fn();
    const { rerender } = render(<PlanPanel sessionId="s1" onToast={onToast} />);
    fireEvent.click(screen.getByRole("button", { name: "待处理" }));
    fireEvent.click(screen.getByRole("button", { name: "同步修改并重新审批" }));
    fireEvent.change(screen.getByRole("textbox", { name: "新增步骤" }), { target: { value: "提交期间才增加的步骤" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    expect(screen.getByText("提交期间才增加的步骤")).toBeInTheDocument();
    expect(onToast).not.toHaveBeenCalled();
    onToast.mockClear();
    act(() => {
      focusSession("s2");
      useSessionStore.getState().requestPlanApproval({ requestId: "approval-new", sessionId: "s2", toolCallId: "tool-new" });
    });
    rerender(<PlanPanel sessionId="s2" onToast={onToast} />);
    await act(async () => acknowledge(true));
    expect(onToast).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "批准执行" })).toBeEnabled();
    expect(useSessionStore.getState().transcripts.s2.planApprovals[0].requestId).toBe("approval-new");
    expect(useSessionStore.getState().transcripts.s1.planRevisionDirty).toBe(true);
    expect(useSessionStore.getState().transcripts.s1.plan?.entries.slice(-1)[0]?.content).toBe("提交期间才增加的步骤");
    expect(mocks.resolvePlanApproval).toHaveBeenCalledWith("approval-late", "cancelled", expect.not.stringContaining("提交期间才增加的步骤"));
  });

  it("步骤输入尚未确认时不批准旧计划，保存后才能提交修订", () => {
    useSessionStore.getState().requestPlanApproval({ requestId: "approval-draft", sessionId: "s1", toolCallId: "tool-draft" });
    render(<PlanPanel sessionId="s1" />);
    fireEvent.doubleClick(screen.getByText("步骤一"));
    fireEvent.change(screen.getByDisplayValue("步骤一"), { target: { value: "尚未保存的步骤修订" } });
    expect(screen.getByRole("button", { name: /^(批准执行|同步修改并重新审批)$/ })).toBeDisabled();
    expect(mocks.resolvePlanApproval).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByDisplayValue("尚未保存的步骤修订"), { key: "Enter" });
    expect(screen.getByRole("button", { name: "同步修改并重新审批" })).toBeEnabled();
    fireEvent.change(screen.getByRole("textbox", { name: "新增步骤" }), { target: { value: "未添加的新步骤" } });
    expect(screen.getByRole("button", { name: "同步修改并重新审批" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    expect(screen.getByRole("button", { name: "同步修改并重新审批" })).toBeEnabled();
  });

  it("未经编辑的待审批计划继续使用既有批准执行结果", async () => {
    useSessionStore.getState().requestPlanApproval({ requestId: "approval-clean", sessionId: "s1", toolCallId: "tool-clean" });
    mocks.resolvePlanApproval.mockResolvedValue(true);
    const onApprovalResolved = vi.fn();
    render(<PlanPanel sessionId="s1" onApprovalResolved={onApprovalResolved} />);
    fireEvent.click(screen.getByRole("button", { name: "批准执行" }));
    await waitFor(() => expect(onApprovalResolved).toHaveBeenCalledWith("approved", ["步骤一", "步骤二", "步骤三"]));
    expect(mocks.resolvePlanApproval).toHaveBeenCalledWith("approval-clean", "approved", undefined);
    expect(useSessionStore.getState().transcripts.s1.planRevisionDirty).toBe(false);
  });

  it("删除全部步骤仍可新增或撤销删除，空计划不能同步或批准旧计划", () => {
    useSessionStore.getState().requestPlanApproval({ requestId: "approval-empty", sessionId: "s1", toolCallId: "tool-empty" });
    const onSend = vi.fn();
    render(<PlanPanel sessionId="s1" onSend={onSend} />);
    fireEvent.change(screen.getByRole("textbox", { name: "新增步骤" }), { target: { value: "清空时仍保留的新增草稿" } });
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getAllByRole("button", { name: "删除此任务" })[0]);
    expect(screen.getByRole("textbox", { name: "新增步骤" })).toHaveValue("清空时仍保留的新增草稿");
    expect(screen.getByRole("button", { name: "同步修改并重新审批" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "同步修订" })).toBeDisabled();
    expect(mocks.resolvePlanApproval).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "撤销删除" }));
    expect(screen.getByText("步骤三")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "新增步骤" })).toHaveValue("清空时仍保留的新增草稿");
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    expect(screen.getByRole("button", { name: "同步修改并重新审批" })).toBeEnabled();
    expect(useSessionStore.getState().transcripts.s1.planRevisionDirty).toBe(true);
  });

  it("正在编辑的步骤须先保存或取消，删除不能使输入草稿失去归属", () => {
    render(<PlanPanel sessionId="s1" />);
    fireEvent.doubleClick(screen.getByText("步骤一"));
    fireEvent.change(screen.getByDisplayValue("步骤一"), { target: { value: "删除前保留的输入" } });
    fireEvent.click(screen.getAllByRole("button", { name: "删除此任务" })[0]);
    expect(screen.getByDisplayValue("删除前保留的输入")).toBeInTheDocument();
    expect(useSessionStore.getState().plan?.entries).toHaveLength(3);
    fireEvent.keyDown(screen.getByDisplayValue("删除前保留的输入"), { key: "Escape" });
    fireEvent.click(screen.getAllByRole("button", { name: "删除此任务" })[0]);
    expect(useSessionStore.getState().plan?.entries).toHaveLength(2);
  });

  it("计划新增及编辑不会被中文输入法候选确认提前提交", () => {
    render(<PlanPanel sessionId="s1" />);
    const add = screen.getByRole("textbox", { name: "新增步骤" });
    fireEvent.change(add, { target: { value: "中文步骤" } });
    fireEvent.keyDown(add, { key: "Enter", isComposing: true });
    expect(setPlan).not.toHaveBeenCalled();
    fireEvent.doubleClick(screen.getByText("步骤一"));
    const edit = screen.getByDisplayValue("步骤一");
    fireEvent.change(edit, { target: { value: "中文修订" } });
    fireEvent.keyDown(edit, { key: "Enter", isComposing: true });
    fireEvent.keyDown(edit, { key: "Escape", isComposing: true });
    expect(setPlan).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue("中文修订")).toBeInTheDocument();
    fireEvent.keyDown(edit, { key: "Enter" });
    expect(capturedPlan()!.entries[0].content).toBe("中文修订");
  });

  it("会话切换清除输入草稿、隔离并保留各自的未同步标记", () => {
    const { rerender } = render(<PlanPanel sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "待处理" }));
    expect(screen.getByRole("button", { name: "同步修订" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "新增步骤" }), { target: { value: "A 的草稿" } });
    fireEvent.doubleClick(screen.getByText("步骤一"));
    fireEvent.change(screen.getByDisplayValue("步骤一"), { target: { value: "A 的未保存编辑" } });
    act(() => focusSession("s2"));
    rerender(<PlanPanel sessionId="s2" />);
    expect(screen.queryByDisplayValue("A 的未保存编辑")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "新增步骤" })).toHaveValue("");
    expect(screen.queryByRole("button", { name: "同步修订" })).not.toBeInTheDocument();
    act(() => focusSession("s1"));
    rerender(<PlanPanel sessionId="s1" />);
    expect(screen.getByRole("button", { name: "同步修订" })).toBeInTheDocument();
  });

  it("已编辑计划收起后重开仍可同步，成功提交后清除标记", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const onToast = vi.fn();
    const first = render(<PlanPanel sessionId="s1" onSend={onSend} />);
    fireEvent.doubleClick(screen.getByText("步骤一"));
    const edit = screen.getByDisplayValue("步骤一");
    fireEvent.change(edit, { target: { value: "已保存的本地修订" } });
    fireEvent.keyDown(edit, { key: "Enter" });
    first.unmount();

    render(<PlanPanel sessionId="s1" onSend={onSend} onToast={onToast} />);
    expect(screen.getByText("已保存的本地修订")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "同步修订" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "同步修订" })).not.toBeInTheDocument());
    expect(onSend).toHaveBeenCalledWith(expect.stringContaining("已保存的本地修订"));
    expect(useSessionStore.getState().transcripts.s1.planRevisionDirty).toBe(false);
    expect(onToast).toHaveBeenCalledWith("修改已提交，等待继续执行");
  });

  it("收起后的未同步修订不会出现在另一会话，返回原会话仍可提交", () => {
    const first = render(<PlanPanel sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "待处理" }));
    first.unmount();
    focusSession("s2");
    const second = render(<PlanPanel sessionId="s2" />);
    expect(screen.queryByRole("button", { name: "同步修订" })).not.toBeInTheDocument();
    second.unmount();
    focusSession("s1");
    render(<PlanPanel sessionId="s1" />);
    expect(screen.getByRole("button", { name: "同步修订" })).toBeInTheDocument();
  });

  it("同步确认晚到不会清除等待期间的新编辑，重开仍保留提交入口", async () => {
    let finishSync!: (accepted: boolean) => void;
    const onSend = vi.fn(() => new Promise<boolean>((resolve) => { finishSync = resolve; }));
    const first = render(<PlanPanel sessionId="s1" onSend={onSend} />);
    fireEvent.click(screen.getByRole("button", { name: "待处理" }));
    fireEvent.click(screen.getByRole("button", { name: "同步修订" }));
    fireEvent.change(screen.getByRole("textbox", { name: "新增步骤" }), { target: { value: "同步期间的新步骤" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    await act(async () => finishSync(true));
    expect(screen.getByRole("button", { name: "同步修订" })).toBeInTheDocument();
    first.unmount();
    render(<PlanPanel sessionId="s1" onSend={onSend} />);
    expect(screen.getByText("同步期间的新步骤")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "同步修订" })).toBeInTheDocument();
  });

  it("Runtime 新计划与新审批初始化不保留旧修订标记", () => {
    render(<PlanPanel sessionId="s1" />);
    expect(screen.queryByRole("button", { name: "同步修订" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "待处理" }));
    expect(screen.getByRole("button", { name: "同步修订" })).toBeInTheDocument();
    act(() => useSessionStore.getState().applyUpdate({
      sessionUpdate: "plan",
      plan: initialPlan(),
      __sessionId: "s1",
    } as never));
    expect(screen.queryByRole("button", { name: "同步修订" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "待处理" }));
    act(() => useSessionStore.getState().requestPlanApproval({
      requestId: "fresh-approval",
      sessionId: "s1",
      toolCallId: "fresh-tool",
    }));
    expect(screen.getByRole("button", { name: "批准执行" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "同步修订" })).not.toBeInTheDocument();
  });

  it("旧会话审批晚到失败不会给新会话错误或解除新审批的等待", async () => {
    mocks.planApproval = { requestId: "a1", sessionId: "s1", toolCallId: "t1" };
    useSessionStore.getState().requestPlanApproval(mocks.planApproval);
    let rejectOld!: (error: Error) => void;
    let finishNew!: (result: boolean) => void;
    mocks.resolvePlanApproval
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishNew = resolve; }));
    const onToast = vi.fn();
    const { rerender } = render(<PlanPanel sessionId="s1" onToast={onToast} />);
    fireEvent.click(screen.getByRole("button", { name: "批准执行" }));
    mocks.planApproval = { requestId: "a2", sessionId: "s2", toolCallId: "t2" };
    act(() => {
      focusSession("s2");
      useSessionStore.getState().requestPlanApproval(mocks.planApproval!);
    });
    rerender(<PlanPanel sessionId="s2" onToast={onToast} />);
    fireEvent.click(screen.getByRole("button", { name: "批准执行" }));
    await act(async () => rejectOld(new Error("A 审批失败")));
    expect(onToast).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "批准执行" })).toBeDisabled();
    await act(async () => finishNew(true));
    expect(screen.queryByRole("button", { name: "批准执行" })).not.toBeInTheDocument();
  });

  it("卸载后审批持久化晚到失败保留停止执行回调与原请求，不发全局错误提示", async () => {
    useSessionStore.getState().requestPlanApproval({ requestId: "approval-unmount", sessionId: "s1", toolCallId: "tool-unmount" });
    mocks.resolvePlanApproval.mockResolvedValue(true);
    let rejectPersistence!: (error: Error) => void;
    const onApprovalResolved = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectPersistence = reject; }));
    const onApprovalSyncFailed = vi.fn();
    const onToast = vi.fn();
    const { unmount } = render(<PlanPanel
      sessionId="s1"
      onToast={onToast}
      onApprovalResolved={onApprovalResolved}
      onApprovalSyncFailed={onApprovalSyncFailed}
    />);
    fireEvent.click(screen.getByRole("button", { name: "批准执行" }));
    await waitFor(() => expect(onApprovalResolved).toHaveBeenCalledWith("approved", ["步骤一", "步骤二", "步骤三"]));
    unmount();
    await act(async () => rejectPersistence(new Error("旧任务保存失败")));
    expect(onApprovalSyncFailed).toHaveBeenCalledWith("旧任务保存失败");
    expect(onToast).not.toHaveBeenCalled();
    expect(useSessionStore.getState().transcripts.s1.planApprovals[0].requestId).toBe("approval-unmount");
  });

  it("头部同步修订的旧审批确认不向新会话发提示，仍完成所属任务回调与dismiss", async () => {
    useSessionStore.getState().requestPlanApproval({ requestId: "header-old", sessionId: "s1", toolCallId: "header-tool" });
    let acknowledge!: (accepted: boolean) => void;
    mocks.resolvePlanApproval.mockImplementationOnce(() => new Promise<boolean>((resolve) => { acknowledge = resolve; }));
    const onToast = vi.fn();
    const onApprovalResolved = vi.fn();
    const { rerender } = render(<PlanPanel sessionId="s1" onToast={onToast} onApprovalResolved={onApprovalResolved} />);
    fireEvent.click(screen.getByRole("button", { name: "待处理" }));
    fireEvent.click(screen.getByRole("button", { name: "同步修订" }));
    act(() => {
      focusSession("s2");
      useSessionStore.getState().requestPlanApproval({ requestId: "header-new", sessionId: "s2", toolCallId: "header-new-tool" });
    });
    rerender(<PlanPanel sessionId="s2" onToast={onToast} onApprovalResolved={onApprovalResolved} />);
    await act(async () => acknowledge(true));
    expect(onToast).not.toHaveBeenCalled();
    expect(onApprovalResolved).toHaveBeenCalledWith("cancelled", ["步骤一", "步骤二", "步骤三"]);
    expect(useSessionStore.getState().transcripts.s1.planApprovals).toHaveLength(0);
    expect(useSessionStore.getState().transcripts.s1.planRevisionDirty).toBe(true);
    expect(useSessionStore.getState().transcripts.s2.planApprovals[0].requestId).toBe("header-new");
  });

  it.each(["同步修改并重新审批", "同步修订"])("同会话新请求替换旧请求后，%s旧成功不显示新审批的反馈", async (button) => {
    useSessionStore.getState().requestPlanApproval({ requestId: "replaced-old", sessionId: "s1", toolCallId: "replaced-tool" });
    let acknowledge!: (accepted: boolean) => void;
    mocks.resolvePlanApproval.mockImplementationOnce(() => new Promise<boolean>((resolve) => { acknowledge = resolve; }));
    const onToast = vi.fn();
    render(<PlanPanel sessionId="s1" onToast={onToast} />);
    fireEvent.click(screen.getByRole("button", { name: "待处理" }));
    fireEvent.click(screen.getByRole("button", { name: button }));
    act(() => {
      useSessionStore.getState().dismissPlanApproval("replaced-old", "s1");
      useSessionStore.getState().requestPlanApproval({ requestId: "replaced-new", sessionId: "s1", toolCallId: "replaced-new-tool" });
    });
    await act(async () => acknowledge(true));
    expect(onToast).not.toHaveBeenCalled();
    expect(useSessionStore.getState().transcripts.s1.planApprovals[0].requestId).toBe("replaced-new");
    expect(screen.getByRole("button", { name: "批准执行" })).toBeEnabled();
  });

  it.each([
    { outcome: "success", unmountView: false },
    { outcome: "busy", unmountView: false },
    { outcome: "error", unmountView: true },
  ])("无审批同步的迟到$outcome不污染离开的界面，真实同步状态仍按ACK保存", async ({ outcome, unmountView }) => {
    let resolveSend!: (accepted: boolean) => void;
    let rejectSend!: (error: Error) => void;
    const onSend = vi.fn(() => new Promise<boolean>((resolve, reject) => { resolveSend = resolve; rejectSend = reject; }));
    const onToast = vi.fn();
    const view = render(<PlanPanel sessionId="s1" onSend={onSend} onToast={onToast} />);
    fireEvent.click(screen.getByRole("button", { name: "待处理" }));
    fireEvent.click(screen.getByRole("button", { name: "同步修订" }));
    if (unmountView) view.unmount();
    else {
      act(() => focusSession("s2"));
      view.rerender(<PlanPanel sessionId="s2" onSend={onSend} onToast={onToast} />);
    }
    await act(async () => {
      if (outcome === "error") rejectSend(new Error("旧同步断网"));
      else resolveSend(outcome === "success");
    });
    expect(onToast).not.toHaveBeenCalled();
    expect(useSessionStore.getState().transcripts.s1.planRevisionDirty).toBe(outcome !== "success");
    if (!unmountView) expect(useSessionStore.getState().sessionId).toBe("s2");
  });

  it.each(["busy", "error"])("当前会话无审批同步%s仍提示失败并保留修订重试", async (outcome) => {
    const onSend = outcome === "busy" ? vi.fn().mockResolvedValue(false) : vi.fn().mockRejectedValue(new Error("网络不可用"));
    const onToast = vi.fn();
    render(<PlanPanel sessionId="s1" onSend={onSend} onToast={onToast} />);
    fireEvent.click(screen.getByRole("button", { name: "待处理" }));
    fireEvent.click(screen.getByRole("button", { name: "同步修订" }));
    await waitFor(() => expect(onToast).toHaveBeenCalledWith(outcome === "busy" ? "当前会话正在工作，修订计划尚未同步" : "同步失败：网络不可用"));
    expect(useSessionStore.getState().transcripts.s1.planRevisionDirty).toBe(true);
    expect(screen.getByRole("button", { name: "同步修订" })).toBeEnabled();
  });

  it.each([
    { outcome: "success", unmountView: false },
    { outcome: "error", unmountView: true },
  ])("计划模式迟到$outcome不向离开的会话或卸载界面发提示", async ({ outcome, unmountView }) => {
    let resolveMode!: () => void;
    let rejectMode!: (error: Error) => void;
    togglePlanMode.mockImplementationOnce(() => new Promise<void>((resolve, reject) => { resolveMode = resolve; rejectMode = reject; }));
    const onToast = vi.fn();
    const view = render(<PlanPanel sessionId="s1" onToast={onToast} />);
    fireEvent.click(screen.getByRole("button", { name: "计划模式" }));
    expect(togglePlanMode).toHaveBeenCalledWith("s1", true);
    if (unmountView) view.unmount();
    else {
      act(() => focusSession("s2"));
      view.rerender(<PlanPanel sessionId="s2" onToast={onToast} />);
    }
    await act(async () => {
      if (outcome === "error") rejectMode(new Error("旧模式请求断网"));
      else resolveMode();
    });
    expect(onToast).not.toHaveBeenCalled();
  });

  it("当前会话计划模式失败仍显示可理解错误", async () => {
    togglePlanMode.mockRejectedValueOnce(new Error("模式服务不可用"));
    const onToast = vi.fn();
    render(<PlanPanel sessionId="s1" onToast={onToast} />);
    fireEvent.click(screen.getByRole("button", { name: "计划模式" }));
    await waitFor(() => expect(onToast).toHaveBeenCalledWith("切换失败：模式服务不可用"));
  });

  it("相同步数的会话切换后运行耗时从新会话重新开始", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(<PlanPanel sessionId="s1" />);
      act(() => vi.advanceTimersByTime(3_000));
      expect(screen.getByText("⏱ 2s")).toBeInTheDocument();
      act(() => focusSession("s2"));
      rerender(<PlanPanel sessionId="s2" />);
      expect(screen.queryByText("⏱ 2s")).not.toBeInTheDocument();
      act(() => vi.advanceTimersByTime(1_000));
      expect(screen.getByText("⏱ 0s")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
