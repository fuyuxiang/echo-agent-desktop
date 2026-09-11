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
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

function paneProps(overrides: Partial<Parameters<typeof AgentPane>[0]> = {}) {
  return {
    task: task(),
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
    onApprovePlan: vi.fn(),
    onOpenReport: vi.fn(),
    ...overrides,
  };
}

describe("phase presentation", () => {
  it("marks working phases as active", () => {
    for (const phase of ["planning", "implementing", "verifying", "diagnosing", "repairing"] as const) {
      expect(describePhase(phase).active).toBe(true);
    }
  });

  it("marks settled phases as inactive with a tone", () => {
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
    await user.type(screen.getByLabelText("开发需求"), "增加登录审计");
    await user.click(screen.getByRole("button", { name: "开始开发任务" }));
    expect(props.onStart).toHaveBeenCalledWith("增加登录审计", false);
  });

  it("passes the plan-first choice through", async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.type(screen.getByLabelText("开发需求"), "大改造");
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "开始开发任务" }));
    expect(props.onStart).toHaveBeenCalledWith("大改造", true);
  });

  it("refuses to start without a requirement", () => {
    setup();
    expect(screen.getByRole("button", { name: "开始开发任务" })).toBeDisabled();
  });

  it("refuses to start without a configured model", () => {
    setup({ modelId: undefined, apiReady: false });
    expect(screen.getByRole("button", { name: "开始开发任务" })).toBeDisabled();
    expect(screen.getByText(/尚未配置可用模型/)).toBeInTheDocument();
  });

  it("fills the box from a suggestion", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: "理解代码库" }));
    expect(screen.getByLabelText("开发需求")).toHaveValue(
      "解释这个项目的核心架构、入口和关键数据流",
    );
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

  it("prefers the blocker over the ordinary phase reason", () => {
    render(
      <AgentPane {...paneProps({ phaseReason: "正在实现", blocker: "出现新的错误" })} />,
    );
    expect(screen.queryByText("正在实现")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("出现新的错误");
  });

  it("offers plan approval only while planning", () => {
    const { rerender } = render(
      <AgentPane {...paneProps({ task: task({ phase: "planning" }) })} />,
    );
    expect(screen.getByRole("button", { name: "批准计划" })).toBeInTheDocument();
    rerender(<AgentPane {...paneProps({ task: task({ phase: "implementing" }) })} />);
    expect(screen.queryByRole("button", { name: "批准计划" })).not.toBeInTheDocument();
  });

  it("links to the report once delivered", async () => {
    const user = userEvent.setup();
    const props = paneProps({ task: task({ phase: "delivered" }) });
    render(<AgentPane {...props} />);
    await user.click(screen.getByRole("button", { name: "查看交付报告" }));
    expect(props.onOpenReport).toHaveBeenCalled();
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

  it("blocks input and offers stop while streaming", async () => {
    const user = userEvent.setup();
    const props = paneProps({ streaming: true });
    render(<AgentPane {...props} />);
    expect(screen.getByLabelText("给 Agent 的补充要求")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /停止/ }));
    expect(props.onCancel).toHaveBeenCalled();
  });
});
