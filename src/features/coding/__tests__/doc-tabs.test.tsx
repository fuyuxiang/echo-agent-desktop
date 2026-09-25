import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  deliveryReport: vi.fn(),
  confirmAcceptance: vi.fn(),
  confirmReview: vi.fn(),
  waiveTestFirst: vi.fn(),
}));

vi.mock("../lib/tauri-api", () => ({ codingApi: api }));

import { DeliveryReportTab } from "../main/docs/DeliveryReportTab";
import { TaskDagTab } from "../main/docs/TaskDagTab";
import type { CodingTask, DeliveryReport, QualityGate } from "../lib/types";

function gate(overrides: Partial<QualityGate> = {}): QualityGate {
  return {
    id: "test",
    title: "测试通过",
    status: "satisfied",
    summary: "1 项检查全部通过",
    evidence: ["pnpm test：通过（退出码 0）"],
    ...overrides,
  };
}

function task(overrides: Partial<CodingTask> = {}): CodingTask {
  return {
    schemaVersion: 2,
    id: "t1",
    name: "重构登录",
    requirement: "改成 OIDC",
    phase: "delivered",
    acceptanceCriteria: [],
    taskNodes: [],
    planIssues: [],
    globalConstraints: [],
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

function report(overrides: Partial<DeliveryReport> = {}): DeliveryReport {
  return {
    task: task(),
    gates: [gate()],
    changes: [
      {
        path: "src/auth.ts",
        kind: "modified",
        added: 24,
        removed: 6,
        baselineContent: "old",
        preExisting: false,
      },
    ],
    totalAdded: 24,
    totalRemoved: 6,
    verifications: [],
    problems: [],
    repairRounds: [],
    evidence: [],
    blockers: [],
    deliverable: true,
    ...overrides,
  };
}

describe("DeliveryReportTab", () => {
  beforeEach(() => {
    api.deliveryReport.mockReset();
    api.deliveryReport.mockResolvedValue(report());
    api.confirmAcceptance.mockReset();
    api.confirmAcceptance.mockResolvedValue(undefined);
    api.confirmReview.mockReset();
    api.confirmReview.mockResolvedValue(undefined);
    api.waiveTestFirst.mockReset();
    api.waiveTestFirst.mockResolvedValue({ waiverReason: "仅维护测试数据" });
  });

  it("asks for a task first", () => {
    render(<DeliveryReportTab root="/repo" taskId={null} onOpenFile={vi.fn()} />);
    expect(screen.getByText(/新建开发任务后即可生成交付报告/)).toBeInTheDocument();
  });

  it("states that a delivered task is complete", async () => {
    render(<DeliveryReportTab root="/repo" taskId="t1" onOpenFile={vi.fn()} />);
    expect(await screen.findByText("任务已完成")).toBeInTheDocument();
  });

  it("refuses to look deliverable when a gate is unmet", async () => {
    api.deliveryReport.mockResolvedValue(
      report({
        deliverable: false,
        gates: [gate({ status: "not_satisfied", summary: "1 项检查未通过" })],
        blockers: ["测试通过：1 项检查未通过"],
      }),
    );
    render(<DeliveryReportTab root="/repo" taskId="t1" onOpenFile={vi.fn()} />);
    expect(await screen.findByText("尚不满足交付条件")).toBeInTheDocument();
    expect(screen.getByText("未解决问题")).toBeInTheDocument();
  });

  it("shows a not-applicable gate distinctly from a passing one", async () => {
    api.deliveryReport.mockResolvedValue(
      report({
        gates: [gate({ id: "lint", title: "静态检查通过", status: "not_applicable", summary: "当前工程未识别到该类检查命令", evidence: [] })],
      }),
    );
    render(<DeliveryReportTab root="/repo" taskId="t1" onOpenFile={vi.fn()} />);
    expect(await screen.findByText("不适用")).toBeInTheDocument();
  });

  it("requires an explicit requirements review before code-quality confirmation", async () => {
    const pending = report({
      deliverable: false,
      gates: [
        gate({ id: "requirements_review", title: "需求符合性审查", status: "not_satisfied" }),
        gate({ id: "code_quality_review", title: "代码质量审查", status: "not_satisfied" }),
      ],
    });
    api.deliveryReport.mockResolvedValueOnce(pending).mockResolvedValue(report({
      deliverable: false,
      gates: [
        gate({ id: "requirements_review", title: "需求符合性审查" }),
        gate({ id: "code_quality_review", title: "代码质量审查", status: "not_satisfied" }),
      ],
    }));
    render(<DeliveryReportTab root="/repo" taskId="t1" onOpenFile={vi.fn()} />);
    const actions = await screen.findAllByRole("button", { name: "审查并确认" });
    expect(actions[1]).toBeDisabled();
    await userEvent.click(actions[0]);
    await userEvent.click(screen.getByRole("button", { name: "确认已审查" }));
    expect(api.confirmReview).toHaveBeenCalledWith("/repo", "t1", "requirements");
  });

  it("records an explicit reason when RED is not applicable", async () => {
    api.deliveryReport.mockResolvedValue(report({ task: task({ phase: "paused", phaseReason: "等待红灯测试验证" }) }));
    render(<DeliveryReportTab root="/repo" taskId="t1" onOpenFile={vi.fn()} />);
    const reason = await screen.findByRole("textbox", { name: "测试先行不适用原因" });
    await userEvent.type(reason, "仅维护测试数据，无生产代码行为变更");
    await userEvent.click(screen.getByRole("button", { name: "说明并豁免" }));
    expect(api.waiveTestFirst).toHaveBeenCalledWith("/repo", "t1", "仅维护测试数据，无生产代码行为变更");
  });

  it("expands an unmet gate's evidence by default", async () => {
    api.deliveryReport.mockResolvedValue(
      report({
        gates: [gate({ status: "not_satisfied", evidence: ["pnpm test：失败（退出码 1）"] })],
      }),
    );
    render(<DeliveryReportTab root="/repo" taskId="t1" onOpenFile={vi.fn()} />);
    expect(await screen.findByText("pnpm test：失败（退出码 1）")).toBeInTheDocument();
  });

  it("opens a changed file", async () => {
    const user = userEvent.setup();
    const onOpenFile = vi.fn();
    render(<DeliveryReportTab root="/repo" taskId="t1" onOpenFile={onOpenFile} />);
    await user.click(await screen.findByText("src/auth.ts"));
    expect(onOpenFile).toHaveBeenCalledWith("src/auth.ts");
  });

  it("shows the exit code each verdict came from", async () => {
    api.deliveryReport.mockResolvedValue(
      report({
        verifications: [
          {
            id: "v1",
            taskId: "t1",
            kind: "test",
            command: "pnpm test",
            status: "failed",
            exitCode: 1,
            stdout: "",
            stderr: "",
            durationMs: 10,
            startedAt: "",
            finishedAt: "",
            structured: false,
          },
        ],
      }),
    );
    render(<DeliveryReportTab root="/repo" taskId="t1" onOpenFile={vi.fn()} />);
    const table = await screen.findByRole("table");
    expect(table).toHaveTextContent("1");
    expect(table).toHaveTextContent("未结构化");
  });

  it("marks acceptance criteria without evidence", async () => {
    api.deliveryReport.mockResolvedValue(
      report({
        task: task({
          acceptanceCriteria: [
            { id: "ac1", content: "登录流程可用", satisfied: false, evidence: [] },
          ],
        }),
      }),
    );
    render(<DeliveryReportTab root="/repo" taskId="t1" onOpenFile={vi.fn()} />);
    expect(await screen.findByText("尚无可追溯的自动验收证据")).toBeInTheDocument();
  });

  it("records an explicit human confirmation for delivered acceptance criteria", async () => {
    const user = userEvent.setup();
    api.deliveryReport.mockResolvedValue(
      report({
        task: task({
          acceptanceCriteria: [
            { id: "ac1", content: "登录流程可用", satisfied: false, evidence: [] },
          ],
        }),
      }),
    );
    render(<DeliveryReportTab root="/repo" taskId="t1" onOpenFile={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "人工确认已满足" }));
    expect(api.confirmAcceptance).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "确认已满足" }));
    expect(api.confirmAcceptance).toHaveBeenCalledWith("/repo", "t1", "ac1");
  });

  it("lists the repair history when the engine retried", async () => {
    api.deliveryReport.mockResolvedValue(
      report({
        repairRounds: [{ round: 1, problemFingerprints: ["a", "b"], startedAt: "", outcome: "new_errors" }],
      }),
    );
    render(<DeliveryReportTab root="/repo" taskId="t1" onOpenFile={vi.fn()} />);
    expect(await screen.findByText(/第 1 轮 · 2 个问题/)).toBeInTheDocument();
  });

  it("surfaces a load failure", async () => {
    api.deliveryReport.mockRejectedValue(new Error("任务不存在"));
    render(<DeliveryReportTab root="/repo" taskId="t1" onOpenFile={vi.fn()} />);
    expect(await screen.findByText("任务不存在")).toBeInTheDocument();
  });
});

describe("TaskDagTab", () => {
  const props = {
    repairRounds: [],
    maxRepairRounds: 3,
    changedFileCount: 2,
    problemCount: 0,
    onOpenFile: vi.fn(),
  };

  it("asks for a task first", () => {
    render(<TaskDagTab {...props} task={null} />);
    expect(screen.getByText(/新建开发任务后即可查看拆解与进度/)).toBeInTheDocument();
  });

  it("explains when Agent has not generated a breakdown yet", () => {
    render(<TaskDagTab {...props} task={task({ phase: "discovering" })} />);
    expect(screen.getByText("Agent 尚未生成执行计划。")).toBeInTheDocument();
  });

  it("lists nodes with dependencies and opens their files", async () => {
    const user = userEvent.setup();
    const onOpenFile = vi.fn();
    render(
      <TaskDagTab
        {...props}
        onOpenFile={onOpenFile}
        task={task({
          taskNodes: [
            {
              id: "T2",
              planKey: "T2",
              content: "接入回调",
              dependencies: ["T1"],
              relatedFiles: ["src/callback.ts"],
              readSet: ["src/auth.ts"],
              writeSet: ["src/callback.ts"],
              consumes: ["AuthSession"],
              produces: ["CallbackHandler"],
              acceptanceCriteria: ["回调可处理"],
              verificationCommands: ["pnpm test"],
              status: "running",
              priority: "high",
              attempt: 1,
            },
          ],
        })}
      />,
    );
    expect(screen.getByText("接入回调")).toBeInTheDocument();
    expect(screen.getByText("依赖 T1")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "src/callback.ts" }));
    expect(onOpenFile).toHaveBeenCalledWith("src/callback.ts");
  });

  it("counts completed nodes", () => {
    render(
      <TaskDagTab
        {...props}
        task={task({
          taskNodes: [
            { id: "T1", planKey: "T1", content: "a", dependencies: [], relatedFiles: [], readSet: [], writeSet: [], consumes: [], produces: [], acceptanceCriteria: [], verificationCommands: [], status: "success", priority: "high", attempt: 1 },
            { id: "T2", planKey: "T2", content: "b", dependencies: [], relatedFiles: [], readSet: [], writeSet: [], consumes: [], produces: [], acceptanceCriteria: [], verificationCommands: [], status: "pending", priority: "low", attempt: 0 },
          ],
        })}
      />,
    );
    expect(screen.getByText("1/2")).toBeInTheDocument();
  });

  it("shows the repair round budget when repairs ran", () => {
    render(
      <TaskDagTab
        {...props}
        task={task()}
        repairRounds={[{ round: 1, problemFingerprints: [], startedAt: "" }]}
      />,
    );
    expect(screen.getByText("1/3")).toBeInTheDocument();
  });
});
