/**
 * Runtime contract for Echo Code's default Agent workflow.
 *
 * The UI deliberately exposes no Ask/Plan/Agent switch. Understanding,
 * planning and verification are stages of one engineering workflow; runtime
 * permissions remain the independent control for side-effect approval.
 */
export function buildCodingWorkflowPrompt(
  request: string,
  contextPaths: string[] = [],
  followup = false,
): string {
  const normalizedContext = [...new Set(contextPaths.map((path) => path.trim()).filter(Boolean))];
  const contextInstruction = normalizedContext.length > 0
    ? `\n\n用户指定的优先工程上下文（请先阅读并按需追踪依赖）：\n${normalizedContext.map((path) => `- ${path}`).join("\n")}`
    : "";

  return `[回声代码工程执行协议${followup ? "·补充要求" : ""}]

你是默认直接完成任务的编码代理。分析、规划、实施和验证是同一个连续流程，不要让用户选择任务类型。

工作规则：
1. 先阅读工程规则、相关模块、近期变更和现有测试，追踪真实调用链；Bug 必须先定位根因，不做症状性修复。
2. 对产品语义、边界或架构存在歧义的复杂任务，先进行内部 brainstorming：确认目标与约束，比较 2～3 个可行方案及取舍，选择并记录推荐方案后再拆解。仅当一个答案会实质改变实现方向且无法从工程推断时，才向用户询问一个精确问题；其余情况做出可恢复的专业判断并继续。
3. 只有不超过 2 个文件、无公共接口变化的明确小任务可直接实施。其他任务在写代码前必须使用运行时原生 Plan/Task 工具发布执行计划，并在执行时持续更新节点状态；不要把内部计划变成要求用户选择的工作模式。
4. 计划只包含会产生可交付变更的实现节点；只读调研属于规划过程，不单独建立节点。每个节点必须是值得独立审查、可独立验证的最小交付单元，并使用下面的可解析格式。Files、Acceptance、Verify 都是必填项；文件必须是工程根目录下的相对路径，目录范围使用例如 packages/order/** 的写法：

[T1] 节点目标
Depends: -
Files: src/example.ts, src/example.test.ts
Reads: src/contracts.ts
Consumes: ExistingType, existingFunction(input): Output
Produces: NewType, newFunction(input): Output
Acceptance: 可观测的完成条件
Verify: pnpm test -- example.test.ts

5. Depends 必须使用 T1/T2 等节点标识表达真实依赖。多节点修改同一文件时必须建立先后依赖。先定义共享类型/接口，再实现消费者；不得使用没有完整契约的展示型计划冒充执行计划。
6. 按依赖顺序逐节点执行：先写能正确失败的回归测试并观察预期失败，再做最小实现，然后重构并运行节点验证。验证通过后才把节点标记为 completed；不在节点范围外“顺便”重构。
7. 当复杂计划节点彼此可分离时，使用运行时 task/subagent 工具为每个节点启动一个全新的 general-purpose 实现 Agent；只向它提供该节点的目标、上游契约、文件范围、验收条件和验证命令，防止长上下文污染。节点紧密耦合时由主 Agent 在限定上下文中顺序实施。所有实现节点都必须串行写入当前工作区，不得让多个实现 Agent 并发修改。
8. 每个实现节点结束后，主 Agent 必须亲自检查真实差异和命令输出，再使用全新上下文的只读审查 Agent 做两道门禁：先检查需求/计划符合性，通过后再检查代码质量。发现问题必须在解锁下游节点前修复并复审。
9. 全部节点完成后再做一次跨节点整体审查，重新运行与改动匹配的完整测试、类型检查、Lint 和构建。只能基于主 Agent 亲自取得的当前代码的新鲜输出宣告完成；不得信任子 Agent 的自报结果。
10. 如果发现计划冲突、接口变化或下游假设失效，对可恢复的非破坏性问题记录专业裁决并自动修订计划与依赖后继续；只有不可逆操作或无法推断的业务歧义才停下询问用户。

${followup ? "用户补充要求" : "用户需求"}：
${request.trim()}${contextInstruction}`;
}

function issueList(issues: PlanIssue[]): string {
  return issues
    .filter((issue) => issue.severity === "error")
    .map((issue, index) => `${index + 1}. ${issue.message}`)
    .join("\n");
}

/** A rejected plan is repaired in the same task without resetting completed nodes. */
export function buildPlanRevisionInstruction(task: CodingTask): string {
  return `[回声代码·自动修订执行计划]

后端拒绝了当前执行计划：
${issueList(task.planIssues) || "计划契约不完整"}

先停止新的代码写入。重新检查需求、当前差异和已有节点，使用原生 Plan/Task 工具发布完整计划。每个节点必须包含 Depends、Files、Reads、Consumes、Produces、Acceptance、Verify；无依赖或接口可写 -，但 Files、Acceptance、Verify 不得为空。所有文件使用工程相对路径，目录范围使用 /**。保留契约未变化且已经完成的节点标识，修正后再继续实施。`;
}

function lines(label: string, values: string[]): string {
  return `${label}: ${values.length > 0 ? values.join(", ") : "-"}`;
}

/** Bounded context for the next scheduler-owned implementation turn. */
export function buildNodeContinuationInstruction(task: CodingTask, node: TaskNode): string {
  const completed = task.taskNodes
    .filter((candidate) => candidate.status === "success")
    .map((candidate) => `${candidate.planKey}${candidate.produces.length ? ` → ${candidate.produces.join(", ")}` : ""}`);
  return `[回声代码·执行节点 ${node.planKey}]

只继续下面这个由调度器选中的节点，不要提前实现下游节点：
目标: ${node.content}
${lines("Depends", node.dependencies)}
${lines("Files", node.writeSet)}
${lines("Reads", node.readSet)}
${lines("Consumes", node.consumes)}
${lines("Produces", node.produces)}
${lines("Acceptance", node.acceptanceCriteria)}
${lines("Verify", node.verificationCommands)}
已完成上游: ${completed.length > 0 ? completed.join("；") : "-"}

先核对上游真实代码与接口，再完成 RED → GREEN → REFACTOR。不要修改 Files 之外的文件；如果真实影响范围或接口与计划不同，先修订完整计划。只有节点验证通过后才能在 Plan/Task 工具中把 ${node.planKey} 标记为 completed。`;
}

function inferVerificationKind(command: string): VerificationKind {
  if (/\b(?:test|pytest|vitest|jest|spec)\b/i.test(command)) return "test";
  if (/\b(?:lint|clippy|eslint|ruff|vet)\b/i.test(command)) return "lint";
  if (/\b(?:type-?check|tsc|mypy|pyright)\b/i.test(command)) return "type_check";
  if (/\b(?:build|compile|check)\b/i.test(command)) return "build";
  return "custom";
}

/** Merge project checks with every node contract; command text is the identity. */
export function mergeTaskVerificationCommands(
  detected: DetectedCommand[] | null | undefined,
  task: CodingTask | null,
): DetectedCommand[] {
  const commands = new Map((detected ?? []).map((entry) => [entry.command, entry]));
  for (const node of task?.taskNodes ?? []) {
    for (const command of node.verificationCommands) {
      if (!commands.has(command)) {
        commands.set(command, {
          command,
          kind: inferVerificationKind(command),
          label: `节点验证 · ${node.planKey}`,
        });
      }
    }
  }
  return [...commands.values()];
}
import type { CodingTask, DetectedCommand, PlanIssue, TaskNode, VerificationKind } from "./types";
