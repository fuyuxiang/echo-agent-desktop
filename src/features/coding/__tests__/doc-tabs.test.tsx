import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ deliveryReport: vi.fn() }));
const analyze = vi.hoisted(() => vi.fn());

vi.mock("../lib/tauri-api", () => ({ codingApi: api }));
vi.mock("@/lib/agent-client", () => ({
  codingAnalyzeWorkspace: (root: string) => analyze(root),
}));

import { DeliveryReportTab } from "../main/docs/DeliveryReportTab";
import { ProjectProfileTab } from "../main/docs/ProjectProfileTab";
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
    id: "t1",
    name: "重构登录",
    requirement: "改成 OIDC",
    phase: "gating",
    acceptanceCriteria: [],
    taskNodes: [],
    planRequired: false,
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
  });

  it("asks for a task first", () => {
    render(<DeliveryReportTab root="/repo" taskId={null} onOpenFile={vi.fn()} />);
    expect(screen.getByText(/新建开发任务后即可生成交付报告/)).toBeInTheDocument();
  });

  it("states the deliverable verdict from the backend", async () => {
    render(<DeliveryReportTab root="/repo" taskId="t1" onOpenFile={vi.fn()} />);
    expect(await screen.findByText("满足交付条件")).toBeInTheDocument();
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
    expect(await screen.findByText("尚无验证证据")).toBeInTheDocument();
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

  it("explains why there is no breakdown for a direct task", () => {
    render(<TaskDagTab {...props} task={task({ planRequired: false })} />);
    expect(screen.getByText(/未启用先给计划/)).toBeInTheDocument();
  });

  it("says the plan is pending when one was requested", () => {
    render(<TaskDagTab {...props} task={task({ planRequired: true })} />);
    expect(screen.getByText("Agent 尚未提交计划。")).toBeInTheDocument();
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
              content: "接入回调",
              dependencies: ["T1"],
              relatedFiles: ["src/callback.ts"],
              status: "running",
              priority: "high",
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
            { id: "T1", content: "a", dependencies: [], relatedFiles: [], status: "success", priority: "high" },
            { id: "T2", content: "b", dependencies: [], relatedFiles: [], status: "pending", priority: "low" },
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

describe("ProjectProfileTab", () => {
  beforeEach(() => {
    analyze.mockReset();
    analyze.mockResolvedValue({
      root: "/repo",
      name: "echo-agent",
      projectType: "Node",
      fileCount: 1234,
      truncated: false,
      languages: [{ language: "TypeScript", files: 900 }],
      modules: [{ name: "web", path: "packages/web", kind: "Node", dependencies: ["core"] }],
      validationCommands: ["pnpm test"],
      hasGit: true,
      gitBranch: "main",
      gitChangedFiles: 3,
      instructionFiles: ["AGENTS.md"],
      scannedAt: "",
    });
  });

  it("shows the project's shape", async () => {
    render(<ProjectProfileTab root="/repo" onOpenFile={vi.fn()} />);
    expect(await screen.findByText("echo-agent")).toBeInTheDocument();
    expect(screen.getByText("1,234")).toBeInTheDocument();
    expect(screen.getByText("TypeScript")).toBeInTheDocument();
  });

  it("states that modules are manifest-based, not a dependency graph", async () => {
    render(<ProjectProfileTab root="/repo" onOpenFile={vi.fn()} />);
    expect(
      await screen.findByText(/并非源码级依赖分析；调用图与影响范围分析将在后续版本接入/),
    ).toBeInTheDocument();
  });

  it("opens a rule file", async () => {
    const user = userEvent.setup();
    const onOpenFile = vi.fn();
    render(<ProjectProfileTab root="/repo" onOpenFile={onOpenFile} />);
    await user.click(await screen.findByRole("button", { name: "AGENTS.md" }));
    expect(onOpenFile).toHaveBeenCalledWith("AGENTS.md");
  });

  it("warns when the scan hit its cap", async () => {
    analyze.mockResolvedValue({
      root: "/repo",
      name: "big",
      projectType: "",
      fileCount: 12000,
      truncated: true,
      languages: [],
      modules: [],
      validationCommands: [],
      hasGit: false,
      instructionFiles: [],
      scannedAt: "",
    });
    render(<ProjectProfileTab root="/repo" onOpenFile={vi.fn()} />);
    expect(await screen.findByText(/超过扫描上限/)).toBeInTheDocument();
  });

  it("surfaces an analysis failure", async () => {
    analyze.mockRejectedValue(new Error("工程分析失败"));
    render(<ProjectProfileTab root="/repo" onOpenFile={vi.fn()} />);
    expect(await screen.findByText("工程分析失败")).toBeInTheDocument();
  });
});
