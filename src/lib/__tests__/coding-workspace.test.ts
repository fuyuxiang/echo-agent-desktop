import { describe, expect, it } from "vitest";
import type { CodingGitSnapshot, CodingWorkspaceAnalysis } from "@/lib/agent-client";
import type { Plan } from "@/lib/types";
import type { ChatMessage } from "@/stores/session-store";
import {
  buildCodingAgentPrompt,
  buildVerificationReport,
  checkCodingCommandRisk,
  codingProtocolFailureCount,
  codingChangedFilesSinceBaseline,
  createAcceptanceCriteria,
  deriveQualityGates,
  deriveTaskNodes,
  inspectCodingRun,
  inferCodingRequestIntent,
  isDocumentationLevelSatisfied,
  loadCodingSnapshot,
  resolveCodingModeForRequest,
  validationFromResult,
  type CodingRunSnapshot,
  type ValidationRecord,
} from "../coding-workspace";

const analysis: CodingWorkspaceAnalysis = {
  root: "/repo",
  name: "commerce",
  projectType: "Maven + Node.js",
  fileCount: 42,
  truncated: false,
  languages: [{ language: "Java", files: 20 }],
  modules: [
    { name: "orders", path: "services/orders", kind: "Maven", dependencies: ["payments"] },
    { name: "payments", path: "services/payments", kind: "Maven", dependencies: [] },
  ],
  validationCommands: ["mvn test"],
  hasGit: true,
  gitBranch: "feature/cancel-order",
  gitChangedFiles: 2,
  instructionFiles: ["AGENTS.md"],
  scannedAt: "2026-09-10T00:00:00.000Z",
};

const git: CodingGitSnapshot = {
  hasGit: true,
  branch: "feature/cancel-order",
  head: "abc123",
  files: [
    { path: "services/orders/OrderService.java", status: "modified", staged: false, unstaged: true, untracked: false, added: 12, removed: 2 },
    { path: "services/payments/PaymentService.java", status: "modified", staged: false, unstaged: true, untracked: false, added: 8, removed: 1 },
  ],
  totalAdded: 20,
  totalRemoved: 3,
  capturedAt: "2026-09-10T00:00:00.000Z",
};

const passedValidation: ValidationRecord = {
  id: "v1",
  command: "mvn test",
  label: "自动化测试",
  status: "passed",
  exitCode: 0,
  stdout: "BUILD SUCCESS",
  stderr: "",
  durationMs: 830,
  startedAt: "2026-09-10T00:00:00.000Z",
  finishedAt: "2026-09-10T00:00:00.830Z",
  source: "workspace",
};

describe("coding workspace acceptance criteria", () => {
  it("仅在代码工作台内拦截删除当前工作树的命令", () => {
    expect(checkCodingCommandRisk("rm -rf .").level).toBe("high");
    expect(checkCodingCommandRisk("rm -rf ..").level).toBe("high");
    expect(checkCodingCommandRisk("rm -rf ./tmp-cache").level).toBe("medium");
  });

  it("清理列表、去重并自动补齐测试标准", () => {
    const criteria = createAcceptanceCriteria("1. 可取消订单\n- 释放库存\n- 可取消订单");
    expect(criteria.map((item) => item.content)).toEqual([
      "可取消订单",
      "释放库存",
      "新增或修改的自动化测试全部通过",
    ]);
    expect(criteria.every((item) => !item.verified)).toBe(true);
  });

  it("空输入生成五条可执行的交付标准", () => {
    const criteria = createAcceptanceCriteria("");
    expect(criteria).toHaveLength(5);
    expect(criteria.some((item) => item.content.includes("Git Diff"))).toBe(true);
    expect(criteria.some((item) => item.content.includes("测试"))).toBe(true);
  });
});

describe("coding workspace task DAG", () => {
  it("从计划元数据中提取任务编号、依赖和相关文件", () => {
    const plan: Plan = {
      entries: [
        { content: "[T1][depends:none][files:pom.xml] 分析工程", status: "completed", priority: "high" },
        { content: "[T2][depends:T1][files:orders/A.java,payments/B.java] 实现取消", status: "in_progress", priority: "high" },
      ],
    };
    const tasks = deriveTaskNodes(plan);
    expect(tasks[0]).toMatchObject({ id: "T1", dependencies: [], relatedFiles: ["pom.xml"], content: "分析工程" });
    expect(tasks[1]).toMatchObject({ id: "T2", dependencies: ["T1"], relatedFiles: ["orders/A.java", "payments/B.java"] });
  });

  it("兼容无元数据的普通计划，自动建立顺序依赖", () => {
    const plan: Plan = {
      entries: [
        { content: "分析", status: "completed", priority: "medium" },
        { content: "实现", status: "pending", priority: "medium" },
      ],
    };
    expect(deriveTaskNodes(plan).map((task) => task.dependencies)).toEqual([[], ["T1"]]);
  });
});

describe("coding workspace validation and quality gates", () => {
  it("只依据真实退出码标记验证成功，并识别主动停止", () => {
    expect(validationFromResult({
      command: "mvn test",
      stdout: "Tests run: 128, Failures: 0, Errors: 0",
      stderr: "",
      exitCode: 0,
      durationMs: 830,
      timedOut: false,
      truncated: false,
    }, "2026-09-10T00:00:00.000Z").status).toBe("passed");
    expect(validationFromResult({
      command: "mvn test",
      stdout: "",
      stderr: "命令已由用户停止",
      exitCode: null,
      durationMs: 10,
      timedOut: false,
      cancelled: true,
      truncated: false,
    }, "2026-09-10T00:00:00.000Z").status).toBe("cancelled");
  });

  it("真实 Git、完成计划、验证、无冲突和人工验收齐全时门禁全部通过", () => {
    const plan: Plan = {
      entries: [
        { content: "[T1][depends:none] 分析", status: "completed", priority: "high" },
        { content: "[T2][depends:T1] 实现", status: "completed", priority: "high" },
      ],
    };
    const criteria = createAcceptanceCriteria("所有测试通过").map((item) => ({ ...item, verified: true }));
    const gates = deriveQualityGates({ analysis, plan, messages: [], validations: [passedValidation], git, criteria });
    expect(gates).toHaveLength(5);
    expect(gates.every((item) => item.status === "satisfied")).toBe(true);
  });

  it("有失败验证或 Git 冲突时不得将质量门禁标记为通过", () => {
    const gates = deriveQualityGates({
      analysis,
      plan: null,
      messages: [],
      validations: [{ ...passedValidation, status: "failed", exitCode: 1 }],
      git: { ...git, files: [{ ...git.files[0], status: "conflict" }] },
      criteria: createAcceptanceCriteria("所有测试通过"),
    });
    expect(gates.find((item) => item.id === "validation")?.status).toBe("in_progress");
    expect(gates.find((item) => item.id === "conflicts")?.status).toBe("in_progress");
  });

  it("自动修复后同一命令的最新成功结果可以完成验证门禁", () => {
    const gates = deriveQualityGates({
      analysis,
      plan: null,
      messages: [],
      validations: [
        { ...passedValidation, id: "failed", status: "failed", exitCode: 1, startedAt: "2026-09-10T00:00:00.000Z" },
        { ...passedValidation, id: "fixed", startedAt: "2026-09-10T00:01:00.000Z" },
      ],
      git,
      criteria: [],
    });
    expect(gates.find((item) => item.id === "validation")?.status).toBe("satisfied");
    expect(gates.find((item) => item.id === "validation")?.summary).toContain("1/1");
  });

  it("显式启用变更审查时，未逐文件打开 Diff 不得通过门禁", () => {
    const gates = deriveQualityGates({
      analysis,
      plan: null,
      messages: [],
      validations: [],
      git,
      criteria: [],
      reviewedFiles: [git.files[0].path],
    });
    expect(gates.find((item) => item.id === "change_review")?.status).toBe("in_progress");
    expect(gates.find((item) => item.id === "change_review")?.summary).toContain("1/2");
  });
});

describe("coding workspace run health", () => {
  it("有待回答问题时明确显示等待输入，不误报正在分析", () => {
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", complete: true, parts: [{ kind: "text", text: "帮我实现 Hello World" }] },
      { id: "a1", role: "assistant", complete: false, parts: [{
        kind: "tool_call",
        toolCall: {
          toolCallId: "ask-1",
          title: "Ask 2 questions",
          kind: "other",
          status: "in_progress",
          content: [],
        },
      }] },
    ];

    const health = inspectCodingRun({
      messages,
      streaming: true,
      mode: "plan",
      plan: null,
      awaitingQuestion: true,
    });

    expect(health.phase).toBe("awaiting_input");
    expect(health.label).toBe("等待你的回答");
    expect(health.detail).toContain("回答下面的问题");
  });

  it("有待批准工程操作时显示授权状态", () => {
    const health = inspectCodingRun({
      messages: [],
      streaming: true,
      mode: "craft",
      plan: null,
      awaitingPermission: true,
    });

    expect(health.phase).toBe("awaiting_input");
    expect(health.label).toBe("等待操作授权");
  });

  it("连续三次空工具参数失败时判定为协议不兼容而不是继续分析", () => {
    const messages: ChatMessage[] = [{
      id: "assistant-1",
      role: "assistant",
      complete: false,
      parts: [1, 2, 3].map((index) => ({
        kind: "tool_call" as const,
        toolCall: {
          toolCallId: `tool-${index}`,
          title: "read_file",
          kind: "read_file",
          status: "failed" as const,
          content: [{ type: "text" as const, text: "Tool call has invalid JSON arguments: missing field target_file" }],
        },
      })),
    }];
    const health = inspectCodingRun({ messages, streaming: true, mode: "plan", plan: null });
    expect(health.phase).toBe("failed");
    expect(health.issue?.code).toBe("tool_protocol_incompatible");
    expect(health.consecutiveProtocolFailures).toBe(3);
  });

  it("把 Runtime 的 action_stationarity 终止明确显示为失败", () => {
    const health = inspectCodingRun({
      messages: [],
      streaming: false,
      mode: "plan",
      plan: null,
      runtimeError: "action_stationarity",
    });
    expect(health.phase).toBe("failed");
    expect(health.issue?.code).toBe("runtime_error");
    expect(health.label).toContain("重复操作");
  });

  it("只用最新一轮计算状态，模型切换后成功回答不继承旧错误", () => {
    const failedToolParts = [1, 2, 3].map((index) => ({
      kind: "tool_call" as const,
      toolCall: {
        toolCallId: `old-tool-${index}`,
        title: "read_file",
        kind: "read_file",
        status: "failed" as const,
        content: [{ type: "text" as const, text: "missing field target_file" }],
      },
    }));
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", complete: true, parts: [{ kind: "text", text: "修复问题" }] },
      { id: "a1", role: "assistant", complete: true, cancellationCategory: "action_stationarity", parts: failedToolParts },
      { id: "u2", role: "user", complete: true, parts: [{ kind: "text", text: "解释一下" }] },
      { id: "a2", role: "assistant", complete: true, stopReason: "stop", parts: [{ kind: "text", text: "已完成分析" }] },
    ];

    const health = inspectCodingRun({
      messages,
      streaming: false,
      mode: "ask",
      plan: null,
      runtimeError: "action_stationarity",
    });

    expect(health.phase).toBe("completed");
    expect(health.consecutiveProtocolFailures).toBe(0);
    expect(health.issue).toBeUndefined();
    expect(codingProtocolFailureCount(messages)).toBe(3);
  });

  it("Craft 实施需求只返回代码块时不得标记为完成", () => {
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", complete: true, parts: [{ kind: "text", text: "帮我写一个99乘法表" }] },
      { id: "a1", role: "assistant", complete: true, stopReason: "stop", parts: [{ kind: "text", text: "```python\nprint('demo')\n```" }] },
    ];

    const missingChange = inspectCodingRun({
      messages,
      streaming: false,
      mode: "craft",
      plan: null,
      requirement: "帮我写一个99乘法表",
      changedFileCount: 0,
      hasGit: true,
    });
    expect(missingChange.phase).toBe("failed");
    expect(missingChange.issue?.code).toBe("no_changes");

    const applied = inspectCodingRun({
      messages,
      streaming: false,
      mode: "craft",
      plan: null,
      requirement: "帮我写一个99乘法表",
      changedFileCount: 1,
      hasGit: true,
    });
    expect(applied.phase).toBe("completed");
  });

  it("把任务前已有变更与本轮新增或继续修改的文件分开", () => {
    const baseline = { ...git, files: [git.files[0]] };
    const current = {
      ...git,
      files: [
        { ...git.files[0], added: 13 },
        git.files[1],
      ],
    };
    expect(codingChangedFilesSinceBaseline(current, baseline)).toEqual({
      preExisting: [git.files[0].path],
      agent: [git.files[0].path, git.files[1].path],
    });
  });
});

describe("coding workspace mode intent", () => {
  it("识别实施请求并避免误落入 Ask 只读模式", () => {
    expect(inferCodingRequestIntent("帮我写一个99乘法表")).toBe("write");
    expect(inferCodingRequestIntent("完整修复这个问题并运行测试")).toBe("write");
    expect(resolveCodingModeForRequest("ask", "创建 multiplication_table.py")).toEqual({
      mode: "craft",
      intent: "write",
      autoAdjusted: true,
    });
  });

  it("诊断问题仍保持 Ask，避免不必要的代码修改", () => {
    expect(inferCodingRequestIntent("你看看为什么写文件失败了？")).toBe("read");
    expect(resolveCodingModeForRequest("ask", "分析日志里的报错原因").mode).toBe("ask");
  });
});

describe("coding workspace documentation evidence", () => {
  it("拒绝占位文档，只接受包含职责、契约和异常约束的函数文档", () => {
    expect(isDocumentationLevelSatisfied("function", "# 函数文档\n待补充")).toBe(false);
    const content = [
      "# 关键函数参考",
      "## cancelOrder 方法职责",
      "职责：编排订单取消流程，并确保下游服务调用顺序正确。",
      "输入参数：orderId；输出：取消结果。",
      "异常与业务规则：已发货订单拒绝取消，重复请求必须幂等，退款失败不得提前结束，并应保留可追踪的失败状态供后续重试。",
    ].join("\n");
    expect(isDocumentationLevelSatisfied("function", content)).toBe(true);
  });
});

describe("coding workspace prompts and report", () => {
  it("开发提示词要求批准计划、最小 Patch、真实验证和工程规则", () => {
    const prompt = buildCodingAgentPrompt("增加取消订单", createAcceptanceCriteria("所有测试通过"), analysis);
    expect(prompt).toContain("[T1][depends:none][files:path1,path2]");
    expect(prompt).toContain("最多自动修复 3 轮");
    expect(prompt).toContain("apply_patch");
    expect(prompt).toContain("AGENTS.md");
    expect(prompt).toContain("mvn test");
  });

  it("根据 Ask/Craft/Plan 模式、选定上下文和 Git 基线生成不同执行契约", () => {
    const prompt = buildCodingAgentPrompt("定位并修复问题", createAcceptanceCriteria("测试通过"), analysis, {
      mode: "craft",
      contextPaths: ["services/orders/OrderService.java"],
      baselineGit: git,
    });
    expect(prompt).toContain("Craft 模式");
    expect(prompt).toContain("services/orders/OrderService.java");
    expect(prompt).toContain("任务开始前已modified");
    expect(prompt).toContain("target_file");
  });

  it("可从旧版快照安全迁移新增的模式和上下文字段", () => {
    localStorage.setItem(`echo-coding-workspace:${encodeURIComponent("/legacy")}`, JSON.stringify({
      version: 1,
      root: "/legacy",
      requirement: "legacy task",
      acceptanceCriteria: [],
      validationRecords: [],
      docLevels: [],
    }));
    expect(loadCodingSnapshot("/legacy")).toMatchObject({
      version: 2,
      mode: "craft",
      contextPaths: [],
      reviewedFiles: [],
    });
  });

  it("会过滤被损坏的本地快照字段，避免代码工作台启动崩溃", () => {
    localStorage.setItem(`echo-coding-workspace:${encodeURIComponent("/corrupt")}`, JSON.stringify({
      version: 2,
      root: "/corrupt",
      requirement: "continue",
      acceptanceCriteria: [null, { content: 7 }, { content: "  真实标准  ", verified: true }],
      validationRecords: [{ command: null }, { command: "pnpm test", startedAt: "2026-09-11", status: "unknown" }],
      docLevels: ["function", "invalid"],
      contextPaths: ["src/app.ts", 12],
      reviewedFiles: [null, "src/app.ts"],
      baselineGit: { files: "broken" },
    }));

    expect(loadCodingSnapshot("/corrupt")).toMatchObject({
      acceptanceCriteria: [{ content: "真实标准", verified: true }],
      validationRecords: [{ command: "pnpm test", status: "failed" }],
      docLevels: ["function"],
      contextPaths: ["src/app.ts"],
      reviewedFiles: ["src/app.ts"],
      baselineGit: undefined,
    });
  });

  it("拒绝通过当前目录环境变量删除整个代码库", () => {
    expect(checkCodingCommandRisk('rm -rf "$PWD"').level).toBe("high");
    expect(checkCodingCommandRisk("rm -rf ${PWD}").level).toBe("high");
  });

  it("报告包含源需求、分支、质量结论和证据声明", () => {
    const snapshot: CodingRunSnapshot = {
      version: 2,
      root: "/repo",
      requirement: "增加取消订单",
      acceptanceCriteria: createAcceptanceCriteria("所有测试通过"),
      validationRecords: [],
      docLevels: [],
      mode: "plan",
      contextPaths: [],
      reviewedFiles: [],
    };
    const report = buildVerificationReport({
      snapshot,
      analysis,
      evidence: deriveQualityGates({ analysis, plan: null, messages: [], validations: [], git: null, criteria: snapshot.acceptanceCriteria }),
      tasks: [],
      changedFiles: git,
    });
    expect(report).toContain("增加取消订单");
    expect(report).toContain("feature/cancel-order");
    expect(report).toContain("真实变更可审查：未满足");
    expect(report).toContain("本报告仅依据");
  });
});
