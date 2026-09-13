import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/ExecutionProcess", () => ({
  ExecutionProcess: ({ active }: { active: boolean }) => (
    <div data-testid="execution" data-active={active} />
  ),
}));
vi.mock("@/components/Markdown", () => ({
  Markdown: ({ children }: { children: string }) => <div>{children}</div>,
}));
vi.mock("@/components/ModelSelector", () => ({
  ModelSelector: () => <div data-testid="model-selector" />,
}));
vi.mock("@/components/PermissionPicker", () => ({
  PermissionPicker: () => <div data-testid="permission-picker" />,
}));
vi.mock("@/components/PermissionDialog", () => ({
  PermissionInlineCard: () => <div data-testid="permission-card" />,
}));
vi.mock("@/components/QuestionInlineCard", () => ({
  QuestionInlineCard: () => <div data-testid="question-card" />,
}));

import { AgentPane } from "../agent/AgentPane";
import { TaskStarter } from "../agent/TaskStarter";
import { describePhase, isBusyPhase, statusSummary } from "../lib/phase";
import type { CodingTask } from "../lib/types";

function task(overrides: Partial<CodingTask> = {}): CodingTask {
  return {
    id: "t1",
    name: "重构登录",
    requirement: "改成 OIDC",
    phase: "implementing",
    acceptanceCriteria: [],
    taskNodes: [],
    planRequired: false,
    reviewRequired: false,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

function paneProps(overrides: Partial<Parameters<typeof AgentPane>[0]> = {}) {
  return {
    task: task(),
    changeSet: null,
    verifications: [],
    sessionId: "s1",
    messages: [],
    streaming: false,
    awaitingPermission: false,
    awaitingQuestion: false,
    models: [{ id: "m1" }],
    modelId: "m1",
    sending: false,
    onModelChange: vi.fn(),
    onSend: vi.fn(),
    onCancel: vi.fn(),
    onPlanResolved: vi.fn(),
    onPlanSyncFailed: vi.fn(),
    onFinalizeDelivery: vi.fn(),
    onOpenChanges: vi.fn(),
    onOpenReport: vi.fn(),
    ...overrides,
  };
}

describe("phase presentation", () => {
  it("marks working phases as active", () => {
    for (const phase of ["analyzing", "planning", "implementing", "verifying", "diagnosing", "repairing"] as const) {
      expect(describePhase(phase).active).toBe(true);
    }
  });

  it("marks settled phases as inactive with a tone", () => {
    expect(describePhase("gating")).toMatchObject({ label: "待验收", tone: "waiting", active: false });
    expect(describePhase("delivered")).toMatchObject({ tone: "good", active: false });
    expect(describePhase("blocked")).toMatchObject({ tone: "bad", active: false });
    expect(describePhase("idle").active).toBe(false);
  });

  it("summarises only the counts that are non-zero", () => {
    expect(statusSummary({ phase: "verifying", changedFileCount: 0, problemCount: 0 })).toBe("验证中");
    expect(statusSummary({ phase: "verifying", changedFileCount: 3, problemCount: 2 })).toBe(
      "验证中 · 3 个变更 · 2 个问题",
    );
  });

  it("includes the repair round when repairing", () => {
    expect(
      statusSummary({
        phase: "repairing",
        changedFileCount: 1,
        problemCount: 1,
        repairRound: 2,
        maxRepairRounds: 3,
      }),
    ).toContain("修复 2/3");
  });

  it("treats working phases as busy", () => {
    expect(isBusyPhase("implementing")).toBe(true);
    expect(isBusyPhase("gating")).toBe(false);
    expect(isBusyPhase("blocked")).toBe(false);
    expect(isBusyPhase(undefined)).toBe(false);
  });
});

describe("TaskStarter", () => {
  function setup(overrides: Partial<Parameters<typeof TaskStarter>[0]> = {}) {
    const props = {
      models: [{ id: "m1" }],
      modelId: "m1",
      onModelChange: vi.fn(),
      starting: false,
      apiReady: true,
      contextPaths: [],
      onStart: vi.fn(),
      ...overrides,
    };
    render(<TaskStarter {...props} />);
    return props;
  }

  it("starts a task with the entered requirement", async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.type(screen.getByLabelText("任务描述"), "增加登录审计");
    await user.click(screen.getByRole("button", { name: "开始 Agent 任务" }));
    expect(props.onStart).toHaveBeenCalledWith("增加登录审计", "agent");
  });

  it("presents a focused Agent workspace instead of a repeated brand splash", () => {
    setup();
    expect(screen.getByText("Echo Code")).toBeInTheDocument();
    expect(screen.getByText("准备就绪")).toBeInTheDocument();
    expect(screen.getByText("你想怎么处理这个任务？")).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "工作模式" })).toBeInTheDocument();
    expect(screen.getByText(/权限策略独立控制操作审批/)).toBeInTheDocument();
  });

  it("passes Plan as a first-class work mode", async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.type(screen.getByLabelText("任务描述"), "大改造");
    await user.click(screen.getByRole("radio", { name: "Plan" }));
    await user.click(screen.getByRole("button", { name: "生成实施计划" }));
    expect(props.onStart).toHaveBeenCalledWith("大改造", "plan");
  });

  it("supports standard keyboard navigation across work modes", async () => {
    const user = userEvent.setup();
    setup();
    const agent = screen.getByRole("radio", { name: "Agent" });
    agent.focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "Ask" })).toHaveFocus();
    expect(screen.getByRole("radio", { name: "Ask" })).toHaveAttribute("aria-checked", "true");
    await user.keyboard("{End}");
    expect(screen.getByRole("radio", { name: "Agent" })).toHaveFocus();
  });

  it("supports a read-only Ask mode without task-category switches", async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.type(screen.getByLabelText("任务描述"), "为什么会 500？");
    await user.click(screen.getByRole("radio", { name: "Ask" }));
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "开始只读分析" }));
    expect(props.onStart).toHaveBeenCalledWith("为什么会 500？", "ask");
  });

  it("refuses to start without a requirement", () => {
    setup();
    expect(screen.getByRole("button", { name: "开始 Agent 任务" })).toBeDisabled();
  });

  it("refuses to start without a configured model", () => {
    setup({ modelId: undefined, apiReady: false });
    expect(screen.getByRole("button", { name: "开始 Agent 任务" })).toBeDisabled();
    expect(screen.getByText(/尚未配置可用模型/)).toBeInTheDocument();
  });

  it("does not ask users to pre-classify work that Agent can infer", () => {
    setup();
    expect(screen.queryByText("补齐测试")).not.toBeInTheDocument();
    expect(screen.queryByText("实现新功能")).not.toBeInTheDocument();
    expect(screen.queryByText("定位问题")).not.toBeInTheDocument();
  });

  it("shows the pinned context so the Agent's inputs are visible", () => {
    setup({ contextPaths: ["src/auth/login.ts"] });
    expect(screen.getByLabelText("已选定上下文")).toHaveTextContent("login.ts");
  });

  it("surfaces a start failure", () => {
    setup({ error: "启动代码开发失败" });
    expect(screen.getByRole("alert")).toHaveTextContent("启动代码开发失败");
  });
});

describe("AgentPane", () => {
  it("shows the current phase as a status line", () => {
    render(<AgentPane {...paneProps({ task: task({ phase: "verifying" }) })} />);
    expect(screen.getByText("验证中")).toBeInTheDocument();
  });

  it("shows a blocker prominently and asks for a human", () => {
    render(
      <AgentPane
        {...paneProps({
          task: task({ phase: "blocked" }),
          blocker: "已执行 3 轮自动修复仍有 2 个问题未解决",
        })}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("需要人工介入");
    expect(alert).toHaveTextContent("3 轮自动修复");
  });

  it("does not claim to prepare context after a pre-session failure", () => {
    render(
      <AgentPane
        {...paneProps({
          task: task({ phase: "blocked" }),
          sessionId: null,
          blocker: "当前工作区不是 Git 仓库",
        })}
      />,
    );
    expect(screen.queryByText("Agent 正在准备工程上下文…")).not.toBeInTheDocument();
    expect(screen.getByText("Agent 会话未启动。")).toBeInTheDocument();
  });

  it("prefers the blocker over the ordinary phase reason", () => {
    render(
      <AgentPane {...paneProps({ phaseReason: "正在实现", blocker: "出现新的错误" })} />,
    );
    expect(screen.queryByText("正在实现")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("出现新的错误");
  });

  it("shows the runtime plan panel only while planning", () => {
    const { rerender } = render(
      <AgentPane {...paneProps({ task: task({ phase: "planning" }) })} />,
    );
    expect(screen.getByText("暂无任务计划")).toBeInTheDocument();
    rerender(<AgentPane {...paneProps({ task: task({ phase: "implementing" }) })} />);
    expect(screen.queryByText("暂无任务计划")).not.toBeInTheDocument();
  });

  it("links to the report once delivered", async () => {
    const user = userEvent.setup();
    const props = paneProps({ task: task({ phase: "delivered" }) });
    render(<AgentPane {...props} />);
    await user.click(screen.getByRole("button", { name: "交付报告" }));
    expect(props.onOpenReport).toHaveBeenCalled();
  });

  it("completes ordinary tasks without asking for a redundant acceptance click", () => {
    render(<AgentPane {...paneProps({ task: task({ phase: "delivered" }) })} />);
    expect(screen.getByText("任务已完成")).toBeInTheDocument();
    expect(screen.getByText(/未检测到可运行的自动检查/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /确认验收/ })).not.toBeInTheDocument();
  });

  it("presents a completed Ask as an answer rather than a zero-change delivery", () => {
    render(<AgentPane {...paneProps({ task: task({ mode: "ask", phase: "delivered" }) })} />);
    expect(screen.getByText("已回答")).toBeInTheDocument();
    expect(screen.getByText("只读分析已完成")).toBeInTheDocument();
    expect(screen.getByText(/未修改工程文件/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "交付报告" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("继续追问")).toBeInTheDocument();
  });

  it("requires every current diff to be reviewed before manual acceptance", async () => {
    const user = userEvent.setup();
    const finalizeDelivery = vi.fn();
    const openChanges = vi.fn();
    const changeSet = {
      taskId: "t1",
      changes: [
        { path: "src/a.ts", kind: "modified" as const, added: 1, removed: 0, preExisting: false },
        { path: "src/b.ts", kind: "modified" as const, added: 1, removed: 0, preExisting: false },
      ],
      createdAt: "",
      reviewedFiles: ["src/a.ts"],
    };
    render(
      <AgentPane {...paneProps({
        task: task({ phase: "gating", reviewRequired: true }),
        changeSet,
        onFinalizeDelivery: finalizeDelivery,
        onOpenChanges: openChanges,
      })} />,
    );
    expect(screen.getByText("等待你验收")).toBeInTheDocument();
    expect(screen.getByText(/已审阅 1\/2/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认验收" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /查看变更/ }));
    expect(openChanges).toHaveBeenCalled();
    expect(finalizeDelivery).not.toHaveBeenCalled();
  });

  it("allows manual acceptance after review hashes match current changes", async () => {
    const user = userEvent.setup();
    const finalizeDelivery = vi.fn();
    render(
      <AgentPane {...paneProps({
        task: task({ phase: "gating", reviewRequired: true }),
        changeSet: {
          taskId: "t1",
          changes: [
            { path: "src/a.ts", kind: "modified", added: 1, removed: 0, preExisting: false },
          ],
          createdAt: "",
          reviewedFiles: ["src/a.ts"],
          reviewedHashes: { "src/a.ts": "current" },
          changeHashes: { "src/a.ts": "current" },
        },
        verifications: [{
          id: "v1",
          taskId: "t1",
          kind: "test",
          command: "pnpm test",
          status: "passed",
          exitCode: 0,
          stdout: "",
          stderr: "",
          durationMs: 1,
          startedAt: "",
          finishedAt: "",
          structured: false,
        }],
        onFinalizeDelivery: finalizeDelivery,
      })} />,
    );
    expect(screen.getByText(/1 项自动检查已通过/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "确认验收" }));
    expect(finalizeDelivery).toHaveBeenCalledOnce();
  });

  it("renders permission and question cards when the Agent is waiting", () => {
    render(<AgentPane {...paneProps({ awaitingPermission: true, awaitingQuestion: true })} />);
    expect(screen.getByTestId("permission-card")).toBeInTheDocument();
    expect(screen.getByTestId("question-card")).toBeInTheDocument();
  });

  it("sends a follow-up and clears the box", async () => {
    const user = userEvent.setup();
    const props = paneProps();
    render(<AgentPane {...props} />);
    const box = screen.getByLabelText("给 Agent 的补充要求");
    await user.type(box, "再补一个测试");
    await user.click(screen.getByRole("button", { name: "发送给 Agent" }));
    expect(props.onSend).toHaveBeenCalledWith("再补一个测试");
    expect(box).toHaveValue("");
  });

  it("keeps a follow-up draft when the host rejects the send", async () => {
    const user = userEvent.setup();
    const props = paneProps({ onSend: vi.fn(async () => false) });
    render(<AgentPane {...props} />);
    const box = screen.getByLabelText("给 Agent 的补充要求");
    await user.type(box, "这条要稍后重试");
    await user.click(screen.getByRole("button", { name: "发送给 Agent" }));
    expect(box).toHaveValue("这条要稍后重试");
  });

  it("disables follow-ups when the task has no bound session", () => {
    render(<AgentPane {...paneProps({ sessionId: null })} />);
    const box = screen.getByLabelText("给 Agent 的补充要求");
    expect(box).toBeDisabled();
    expect(box).toHaveAttribute("placeholder", "当前任务未绑定 Agent 会话");
  });

  it("blocks input and offers stop while streaming", async () => {
    const user = userEvent.setup();
    const props = paneProps({ streaming: true });
    render(<AgentPane {...props} />);
    expect(screen.getByLabelText("给 Agent 的补充要求")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /停止/ }));
    expect(props.onCancel).toHaveBeenCalled();
  });
});
