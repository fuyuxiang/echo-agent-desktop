import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/ExecutionProcess", () => ({ ExecutionProcess: () => <div data-testid="execution" /> }));
vi.mock("@/components/Markdown", () => ({ Markdown: ({ children }: { children: string }) => <div>{children}</div> }));
vi.mock("@/components/ModelSelector", () => ({ ModelSelector: () => <div data-testid="model-selector" /> }));
vi.mock("@/components/PermissionPicker", () => ({ PermissionPicker: () => <div data-testid="permission-picker" /> }));
vi.mock("@/components/PermissionDialog", () => ({ PermissionInlineCard: () => <div data-testid="permission-card" /> }));
vi.mock("@/components/QuestionInlineCard", () => ({ QuestionInlineCard: () => <div data-testid="question-card" /> }));

import { AgentPane } from "../agent/AgentPane";
import { TaskStarter } from "../agent/TaskStarter";
import { describePhase, isBusyPhase, statusSummary } from "../lib/phase";
import type { CodingTask, TaskNode } from "../lib/types";

function task(overrides: Partial<CodingTask> = {}): CodingTask {
  return {
    schemaVersion: 2, id: "t1", name: "重构登录", requirement: "改成 OIDC", phase: "implementing",
    acceptanceCriteria: [], taskNodes: [], planIssues: [], globalConstraints: [], createdAt: "", updatedAt: "", ...overrides,
  };
}

function node(overrides: Partial<TaskNode> = {}): TaskNode {
  return {
    id: "node-1", planKey: "T1", content: "建立订单域模型", dependencies: [],
    relatedFiles: ["src/order.ts"], readSet: [], writeSet: ["src/order.ts"], consumes: [],
    produces: ["OrderService"], acceptanceCriteria: ["订单可创建"], verificationCommands: ["pnpm test"],
    status: "running", priority: "high", attempt: 1, ...overrides,
  };
}

function paneProps(overrides: Partial<Parameters<typeof AgentPane>[0]> = {}) {
  return {
    task: task(), changeSet: null, verifications: [], sessionId: "s1", messages: [], streaming: false,
    awaitingPermission: false, awaitingQuestion: false, models: [{ id: "m1" }], modelId: "m1", sending: false,
    onModelChange: vi.fn(), onSend: vi.fn(), onCancel: vi.fn(), onOpenChanges: vi.fn(), onOpenReport: vi.fn(), ...overrides,
  };
}

describe("phase presentation", () => {
  it("marks engine-owned phases as active and terminal phases inactive", () => {
    for (const phase of ["discovering", "implementing", "verifying", "diagnosing", "repairing"] as const) {
      expect(describePhase(phase).active).toBe(true);
    }
    expect(describePhase("delivered")).toMatchObject({ tone: "good", active: false });
    expect(describePhase("blocked")).toMatchObject({ tone: "bad", active: false });
    expect(isBusyPhase("blocked")).toBe(false);
  });

  it("summarises meaningful counts and repair rounds", () => {
    expect(statusSummary({ phase: "verifying", changedFileCount: 3, problemCount: 2 }))
      .toBe("验证中 · 3 个变更 · 2 个问题");
    expect(statusSummary({ phase: "repairing", changedFileCount: 1, problemCount: 1, repairRound: 2, maxRepairRounds: 3 }))
      .toContain("修复 2/3");
  });
});

describe("TaskStarter", () => {
  function setup(overrides: Partial<Parameters<typeof TaskStarter>[0]> = {}) {
    const props = { models: [{ id: "m1" }], modelId: "m1", onModelChange: vi.fn(), starting: false,
      apiReady: true, contextPaths: [], onStart: vi.fn(), ...overrides };
    render(<TaskStarter {...props} />);
    return props;
  }

  it("starts the single Agent workflow with natural language", async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.type(screen.getByLabelText("任务描述"), "增加登录审计");
    await user.click(screen.getByRole("button", { name: "开始 Agent 任务" }));
    expect(props.onStart).toHaveBeenCalledWith("增加登录审计");
  });

  it("keeps only permission and model controls", () => {
    setup();
    expect(screen.getByText("和 Echo 一起构建")).toBeInTheDocument();
    expect(screen.getByTestId("permission-picker")).toBeInTheDocument();
    expect(screen.getByTestId("model-selector")).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("requires a requirement and a configured model", () => {
    setup({ modelId: undefined, apiReady: false });
    expect(screen.getByRole("button", { name: "开始 Agent 任务" })).toBeDisabled();
    expect(screen.getByText(/尚未配置可用模型/)).toBeInTheDocument();
  });

  it("shows pinned engineering context", () => {
    setup({ contextPaths: ["src/auth/login.ts"] });
    expect(screen.getByLabelText("已选定上下文")).toHaveTextContent("login.ts");
  });
});

describe("AgentPane", () => {
  it("shows structured plan progress and its active node", () => {
    render(<AgentPane {...paneProps({ task: task({ planRevision: "rev-1", taskNodes: [node()] }) })} />);
    expect(screen.getByLabelText("执行计划进度")).toHaveTextContent("执行计划 0/1");
    expect(screen.getByLabelText("执行计划进度")).toHaveTextContent("T1");
  });

  it("surfaces invalid plan contracts before execution", () => {
    render(<AgentPane {...paneProps({ task: task({ planIssues: [{ severity: "error", code: "write-conflict", message: "T1 与 T2 同时写入 src/a.ts", nodeKeys: ["T1", "T2"] }] }) })} />);
    expect(screen.getByRole("alert")).toHaveTextContent("执行计划需要修正");
  });

  it("delivers after verification without another acceptance click", async () => {
    const user = userEvent.setup();
    const props = paneProps({ task: task({ phase: "delivered" }) });
    render(<AgentPane {...props} />);
    expect(screen.getByText("任务已完成")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /确认验收/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "交付报告" }));
    expect(props.onOpenReport).toHaveBeenCalled();
  });

  it("renders permission and clarification cards when paused", () => {
    render(<AgentPane {...paneProps({ awaitingPermission: true, awaitingQuestion: true })} />);
    expect(screen.getByTestId("permission-card")).toBeInTheDocument();
    expect(screen.getByTestId("question-card")).toBeInTheDocument();
  });

  it("preserves a follow-up draft when the host rejects the send", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn(async () => false);
    render(<AgentPane {...paneProps({ onSend })} />);
    const input = screen.getByLabelText("给 Agent 的补充要求");
    await user.type(input, "再补一个测试");
    await user.click(screen.getByRole("button", { name: "发送给 Agent" }));
    expect(input).toHaveValue("再补一个测试");
  });
});
