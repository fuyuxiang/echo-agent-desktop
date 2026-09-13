import { describe, expect, it } from "vitest";

import { parseRuntimePlan, runtimePlanFingerprint } from "../lib/workflow-plan";
import {
  buildCodingWorkflowPrompt,
  buildNodeContinuationInstruction,
  buildPlanRevisionInstruction,
  mergeTaskVerificationCommands,
} from "../lib/workflow";
import type { CodingTask, TaskNode } from "../lib/types";

const node = (overrides: Partial<TaskNode> = {}): TaskNode => ({
  id: "node-1",
  planKey: "T1",
  content: "实现登录回调",
  dependencies: [],
  relatedFiles: ["src/auth.ts"],
  readSet: ["src/session.ts"],
  writeSet: ["src/auth.ts"],
  consumes: ["Session"],
  produces: ["AuthCallback"],
  acceptanceCriteria: ["回调成功"],
  verificationCommands: ["pnpm test -- auth"],
  status: "running",
  priority: "high",
  attempt: 1,
  ...overrides,
});

const task = (overrides: Partial<CodingTask> = {}): CodingTask => ({
  schemaVersion: 2,
  id: "task-1",
  name: "登录",
  requirement: "实现登录",
  phase: "implementing",
  acceptanceCriteria: [],
  taskNodes: [node()],
  planIssues: [],
  globalConstraints: [],
  createdAt: "",
  updatedAt: "",
  ...overrides,
});

describe("coding workflow contract", () => {
  it("builds one Agent contract with decomposition, TDD and fresh verification", () => {
    const prompt = buildCodingWorkflowPrompt("迁移登录", [" src/auth.ts ", "src/auth.ts"]);
    expect(prompt).toContain("分析、规划、实施和验证");
    expect(prompt).toContain("内部 brainstorming");
    expect(prompt).toContain("运行时原生 Plan/Task 工具");
    expect(prompt).toContain("task/subagent 工具");
    expect(prompt).toContain("两道门禁");
    expect(prompt).toContain("跨节点整体审查");
    expect(prompt).toContain("先写能正确失败的回归测试");
    expect(prompt).toContain("当前代码的新鲜输出");
    expect(prompt.match(/src\/auth\.ts/g)).toHaveLength(1);
  });

  it("keeps follow-ups inside the same engineering workflow", () => {
    const prompt = buildCodingWorkflowPrompt("再增加审计日志", [], true);
    expect(prompt).toContain("工程执行协议·补充要求");
    expect(prompt).toContain("用户补充要求");
  });

  it("builds bounded instructions for plan repair and node continuation", () => {
    const invalid = task({
      nextAction: "revise_plan",
      planIssues: [{
        severity: "error",
        code: "missing_verification",
        message: "T1 没有声明验证命令",
        nodeKeys: ["T1"],
      }],
    });
    expect(buildPlanRevisionInstruction(invalid)).toContain("T1 没有声明验证命令");
    const continuation = buildNodeContinuationInstruction(task(), node());
    expect(continuation).toContain("只继续下面这个由调度器选中的节点");
    expect(continuation).toContain("Files: src/auth.ts");
    expect(continuation).toContain("RED → GREEN → REFACTOR");
  });

  it("merges project checks with node-level verification contracts", () => {
    const commands = mergeTaskVerificationCommands(
      [{ kind: "build", command: "pnpm build", label: "构建" }],
      task(),
    );
    expect(commands).toEqual([
      { kind: "build", command: "pnpm build", label: "构建" },
      { kind: "test", command: "pnpm test -- auth", label: "节点验证 · T1" },
    ]);
  });
});

describe("runtime plan parser", () => {
  it("extracts dependency, file and interface contracts from plan entries", () => {
    const entries = parseRuntimePlan({
      entries: [{
        content: "[T2] 接入回调\nDepends: T1\nFiles: src/callback.ts\nReads: src/auth.ts\nConsumes: AuthSession\nProduces: CallbackHandler\nAcceptance: 回调成功落库\nVerify: pnpm test -- callback.test.ts",
        priority: "high",
        status: "in_progress",
      }],
    });
    expect(entries[0]).toMatchObject({
      key: "T2",
      content: "接入回调",
      dependencies: ["T1"],
      relatedFiles: ["src/callback.ts", "src/auth.ts"],
      writeSet: ["src/callback.ts"],
      consumes: ["AuthSession"],
      produces: ["CallbackHandler"],
      acceptanceCriteria: ["回调成功落库"],
      verificationCommands: ["pnpm test -- callback.test.ts"],
      status: "running",
    });
  });

  it("turns unstructured plans into a conservative sequential DAG", () => {
    const entries = parseRuntimePlan({
      entries: [
        { content: "定义共享接口", priority: "high", status: "completed" },
        { content: "实现消费者", priority: "medium", status: "pending" },
      ],
    });
    expect(entries[0]).toMatchObject({ key: "T1", dependencies: [], status: "success" });
    expect(entries[1]).toMatchObject({ key: "T2", dependencies: ["T1"], status: "pending" });
    expect(runtimePlanFingerprint({ entries: [] })).toBe("[]");
  });
});
