import type { ChatMessage } from "@/stores/session-store";
import type { Plan } from "@/lib/types";
import type {
  CodingCommandResult,
  CodingGitSnapshot,
  CodingWorkspaceAnalysis,
} from "@/lib/agent-client";
import { checkCommandRisk, type CommandRiskResult } from "@/lib/command-risk";

export const CODING_DOC_PATHS = {
  function: ".echoagent/docs/function-reference.md",
  module: ".echoagent/docs/module-overview.md",
  system: ".echoagent/docs/system-architecture.md",
} as const;

export type CodingDocLevel = keyof typeof CODING_DOC_PATHS;

export type CodingAgentMode = "ask" | "craft" | "plan";

export type CodingRequestIntent = "read" | "write" | "unknown";

export interface CodingModeResolution {
  mode: CodingAgentMode;
  intent: CodingRequestIntent;
  autoAdjusted: boolean;
}

export type CodingRunPhase =
  | "idle"
  | "preparing"
  | "analyzing"
  | "planning"
  | "awaiting_input"
  | "awaiting_approval"
  | "implementing"
  | "verifying"
  | "completed"
  | "failed"
  | "stopped";

export interface CodingRunIssue {
  code: "tool_protocol_incompatible" | "no_plan" | "no_changes" | "agent_stopped" | "runtime_error";
  title: string;
  detail: string;
  action: string;
  severity: "warning" | "error";
}

export interface CodingRunHealth {
  phase: CodingRunPhase;
  label: string;
  detail: string;
  toolCount: number;
  completedToolCount: number;
  failedToolCount: number;
  consecutiveProtocolFailures: number;
  issue?: CodingRunIssue;
}

export interface AcceptanceCriterion {
  id: string;
  content: string;
  verified: boolean;
}

export interface CodingTaskNode {
  id: string;
  content: string;
  dependencies: string[];
  relatedFiles: string[];
  status: "pending" | "in_progress" | "completed";
  priority: "high" | "medium" | "low";
}

export interface ValidationRecord {
  id: string;
  command: string;
  label: string;
  status: "running" | "passed" | "failed" | "timed_out" | "cancelled";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  startedAt: string;
  finishedAt?: string;
  testSummary?: string;
  truncated?: boolean;
  source: "workspace" | "agent";
}

export interface CodingRunSnapshot {
  version: 2;
  root: string;
  requirement: string;
  acceptanceCriteria: AcceptanceCriterion[];
  validationRecords: ValidationRecord[];
  sessionId?: string;
  startedAt?: string;
  docLevels: CodingDocLevel[];
  mode: CodingAgentMode;
  modelId?: string;
  contextPaths: string[];
  reviewedFiles: string[];
  baselineGit?: CodingGitSnapshot;
}

export interface QualityGate {
  id: "change_review" | "planning" | "validation" | "conflicts" | "acceptance";
  title: string;
  status: "satisfied" | "in_progress" | "not_satisfied";
  summary: string;
  evidence: string[];
}

const INVALID_TOOL_ARGUMENT_PATTERN = /failed to parse arguments|missing (?:required )?(?:field|parameter)|invalid json arguments|参数(?:缺失|解析失败)/i;

function toolCallText(message: ChatMessage): Array<{
  kind: string;
  title: string;
  status: "in_progress" | "completed" | "failed";
  output: string;
}> {
  return message.parts.flatMap((part) => {
    if (part.kind !== "tool_call") return [];
    const output = part.toolCall.content.flatMap((content) => {
      if (content.type === "text") return [content.text];
      if (content.type === "command_output") return [content.output];
      return [];
    }).join("\n");
    return [{
      kind: part.toolCall.kind,
      title: part.toolCall.title,
      status: part.toolCall.status,
      output,
    }];
  });
}

function currentCodingTurn(messages: ChatMessage[]): ChatMessage[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") return messages.slice(index);
  }
  return messages;
}

export function codingProtocolFailureCount(messages: ChatMessage[]): number {
  return messages
    .flatMap(toolCallText)
    .filter((call) => call.status === "failed" && INVALID_TOOL_ARGUMENT_PATTERN.test(call.output))
    .length;
}

/**
 * Detect requests that clearly expect repository mutation. This deliberately
 * stays conservative: ambiguous questions remain in the mode the user chose,
 * while explicit implementation verbs cannot accidentally be trapped in Ask.
 */
export function inferCodingRequestIntent(text: string): CodingRequestIntent {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!normalized) return "unknown";

  const explicitDiagnosis = /(?:为什么|原因|怎么回事|如何|怎样|是否|能否|可否|解释|分析|审查|检查|查看|看看|定位).*(?:问题|原因|报错|失败|日志|代码|实现|不了|不能|无法)|\b(?:why|explain|analy[sz]e|review|inspect|diagnose|find the cause|how does|what is)\b/i;
  const explicitMutation = /(?:完整修复|直接修复|帮我修复|修好|落地|写入|创建|新建|生成|实现|开发|修改|修复|重构|删除|添加|新增|更新|替换|调整|优化|接入|迁移|升级|补充|改成|做成|做一个|写一个|写个)|\b(?:implement|fix|create|write|add|update|change|modify|refactor|remove|delete|migrate|upgrade|integrate|build)\b/i;
  const asksForAction = /(?:请|帮我|给我|直接|需要|必须|把|将|要求|完整|保证|落地)|\b(?:please|can you|must|go ahead)\b/i;

  if (explicitMutation.test(normalized) && (asksForAction.test(normalized) || !explicitDiagnosis.test(normalized))) {
    return "write";
  }
  if (explicitDiagnosis.test(normalized)) return "read";
  return "unknown";
}

export function resolveCodingModeForRequest(
  requestedMode: CodingAgentMode,
  text: string,
): CodingModeResolution {
  const intent = inferCodingRequestIntent(text);
  if (requestedMode === "ask" && intent === "write") {
    return { mode: "craft", intent, autoAdjusted: true };
  }
  return { mode: requestedMode, intent, autoAdjusted: false };
}

/**
 * Convert the noisy ACP event stream into a small, user-facing coding state.
 * More importantly, identify a broken OpenAI-compatible tool-call stream before
 * the Runtime can spend minutes retrying empty arguments.
 */
export function inspectCodingRun(options: {
  messages: ChatMessage[];
  streaming: boolean;
  mode: CodingAgentMode;
  plan: Plan | null;
  awaitingQuestion?: boolean;
  awaitingPermission?: boolean;
  awaitingApproval?: boolean;
  runtimeError?: string | null;
  requirement?: string;
  changedFileCount?: number;
  hasGit?: boolean;
}): CodingRunHealth {
  // Status and auto-stop belong to the active/latest user turn. Looking at the
  // full persisted transcript made a successful model switch inherit dozens of
  // failures from an older model and permanently display a false red state.
  const turnMessages = currentCodingTurn(options.messages);
  const calls = turnMessages.flatMap(toolCallText);
  const failedCalls = calls.filter((call) => call.status === "failed");
  let consecutiveProtocolFailures = 0;
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index];
    if (call.status === "failed" && INVALID_TOOL_ARGUMENT_PATTERN.test(call.output)) {
      consecutiveProtocolFailures += 1;
      continue;
    }
    break;
  }
  const protocolFailures = calls.filter((call) => INVALID_TOOL_ARGUMENT_PATTERN.test(call.output));
  const completedToolCount = calls.filter((call) => call.status === "completed").length;
  const hasAssistantText = turnMessages.some((message) =>
    message.role === "assistant"
      && message.parts.some((part) => part.kind === "text" && part.text.trim().length > 0));
  const lastAssistant = [...turnMessages].reverse().find((message) => message.role === "assistant");
  const terminalRuntimeError = lastAssistant && (
    ["error", "rate_limit", "rate_limited", "max_turns"].includes(lastAssistant.stopReason ?? "")
      || ["HookDenied", "max_turns_reached", "action_stationarity"].includes(lastAssistant.cancellationCategory ?? "")
  )
    ? lastAssistant.agentResult || lastAssistant.cancellationCategory || lastAssistant.stopReason
    : null;
  const lastAssistantSucceeded = Boolean(
    lastAssistant?.complete
      && hasAssistantText
      && !terminalRuntimeError
      && lastAssistant.stopReason !== "cancelled",
  );
  // The store-level error can outlive the turn that produced it. A later,
  // successful assistant completion is authoritative and clears that stale UX.
  const runtimeError = terminalRuntimeError || (lastAssistantSucceeded ? null : options.runtimeError);

  // Reverse requests suspend the Runtime until the user responds. They are not
  // analysis work, and must take precedence over tool/protocol status so the UI
  // never presents a blocking question or permission prompt as an endless run.
  if (options.awaitingQuestion) {
    return {
      phase: "awaiting_input",
      label: "等待你的回答",
      detail: "Agent 已完成当前判断，请回答下面的问题后继续执行。",
      toolCount: calls.length,
      completedToolCount,
      failedToolCount: failedCalls.length,
      consecutiveProtocolFailures,
    };
  }

  if (options.awaitingPermission) {
    return {
      phase: "awaiting_input",
      label: "等待操作授权",
      detail: "Agent 已准备执行工程操作，请确认下面的权限请求后继续。",
      toolCount: calls.length,
      completedToolCount,
      failedToolCount: failedCalls.length,
      consecutiveProtocolFailures,
    };
  }

  if (options.awaitingApproval) {
    return {
      phase: "awaiting_approval",
      label: "等待批准计划",
      detail: "Agent 已完成工程分析；批准计划后才会修改文件。",
      toolCount: calls.length,
      completedToolCount,
      failedToolCount: failedCalls.length,
      consecutiveProtocolFailures,
    };
  }

  if (consecutiveProtocolFailures >= 3) {
    return {
      phase: "failed",
      label: "模型工具协议异常",
      detail: `连续 ${consecutiveProtocolFailures} 次工具调用缺少必要参数，已停止空转保护。`,
      toolCount: calls.length,
      completedToolCount,
      failedToolCount: failedCalls.length,
      consecutiveProtocolFailures,
      issue: {
        code: "tool_protocol_incompatible",
        title: "当前模型无法完成代码工具调用",
        detail: `模型连续 ${consecutiveProtocolFailures} 次返回空的工具参数（共检测到 ${protocolFailures.length} 次协议错误）。这通常表示当前模型或 OpenAI 兼容网关没有正确实现流式 tool_calls，而不是代码库分析耗时。`,
        action: "切换到支持函数/工具调用的模型后重试；如果使用自定义网关，请确认它会完整返回 function.arguments。",
        severity: "error",
      },
    };
  }

  if (!options.streaming && runtimeError) {
    const stationary = /action[_\s-]?stationarity|repeated identical tool calls/i.test(runtimeError);
    return {
      phase: "failed",
      label: stationary ? "Agent 已停止重复操作" : "Agent Runtime 执行失败",
      detail: stationary
        ? "Runtime 检测到重复的无效工具调用并已终止本轮，不是代码库仍在分析。"
        : runtimeError,
      toolCount: calls.length,
      completedToolCount,
      failedToolCount: failedCalls.length,
      consecutiveProtocolFailures,
      issue: {
        code: "runtime_error",
        title: stationary ? "模型陷入重复工具调用" : "Coding Agent 已异常结束",
        detail: stationary
          ? "当前模型重复返回了无法执行的工具请求，Runtime 已启动 stationarity 保护。"
          : runtimeError,
        action: stationary
          ? "切换到完整支持 tool_calls/function.arguments 的模型后重试。"
          : "查看执行轨迹和模型配置后重试。",
        severity: "error",
      },
    };
  }

  const tasks = deriveTaskNodes(options.plan);
  const lastCall = calls[calls.length - 1];
  const isVerification = lastCall && /(?:test|check|build|lint|compile|pytest|cargo|mvn|gradle)/i.test(`${lastCall.kind} ${lastCall.title}`);
  if (options.streaming) {
    const phase: CodingRunPhase = isVerification
      ? "verifying"
      : options.mode === "plan" && tasks.length === 0
        ? calls.length > 0 ? "analyzing" : "planning"
        : calls.length > 0 ? "implementing" : "preparing";
    const label = {
      preparing: "正在准备上下文",
      analyzing: "正在分析代码库",
      planning: "正在拆解任务",
      implementing: "正在修改代码",
      verifying: "正在验证结果",
    }[phase] ?? "Agent 正在工作";
    return {
      phase,
      label,
      detail: lastCall?.title || (calls.length > 0 ? `${calls.length} 项工程操作` : "正在等待模型返回首个结果"),
      toolCount: calls.length,
      completedToolCount,
      failedToolCount: failedCalls.length,
      consecutiveProtocolFailures,
    };
  }

  if (lastAssistant?.stopReason === "cancelled") {
    return {
      phase: "stopped",
      label: "已停止",
      detail: lastAssistant.cancellationCategory === "session_replay_incomplete"
        ? "上次执行未正常收尾，已关闭历史恢复中的假运行状态。"
        : "本轮已由用户或空转保护停止，可以修改要求后继续。",
      toolCount: calls.length,
      completedToolCount,
      failedToolCount: failedCalls.length,
      consecutiveProtocolFailures,
      issue: {
        code: "agent_stopped",
        title: lastAssistant.cancellationCategory === "session_replay_incomplete"
          ? "上次执行已中断"
          : "Agent 已停止",
        detail: lastAssistant.agentResult || "本轮没有继续执行。",
        action: "使用 Craft 模式新建干净会话后重试。",
        severity: "warning",
      },
    };
  }

  if (options.mode === "plan" && turnMessages.length > 0 && tasks.length === 0 && lastAssistant?.complete) {
    return {
      phase: "failed",
      label: "计划生成失败",
      detail: "本轮已经结束，但 Agent 没有提交可执行计划。",
      toolCount: calls.length,
      completedToolCount,
      failedToolCount: failedCalls.length,
      consecutiveProtocolFailures,
      issue: {
        code: "no_plan",
        title: "Agent 未生成任务计划",
        detail: failedCalls.length > 0
          ? `本轮有 ${failedCalls.length} 项工具操作失败，且没有形成可审批计划。`
          : "模型已结束响应，但没有通过 Plan 协议提交结构化任务。",
        action: "查看执行轨迹后重试；也可以切换模型，或改用 Craft 模式完成小范围修改。",
        severity: "error",
      },
    };
  }

  const latestUserText = turnMessages
    .find((message) => message.role === "user")
    ?.parts.filter((part) => part.kind === "text")
    .map((part) => part.kind === "text" ? part.text : "")
    .join("\n") ?? "";
  const turnIntent = inferCodingRequestIntent(latestUserText);
  const requirementIntent = inferCodingRequestIntent(options.requirement ?? "");
  const implementationExpected = options.mode === "craft"
    && (turnIntent === "write" || (turnIntent === "unknown" && requirementIntent === "write"));
  const hasMutatingTool = calls.some((call) =>
    call.status === "completed"
      && /(?:write|edit|patch|create|delete|rename|move|terminal|command)|(?:写入|修改|创建|删除|重命名|命令)/i.test(`${call.kind} ${call.title}`));
  const implementationApplied = options.hasGit === false
    ? hasMutatingTool
    : (options.changedFileCount ?? 0) > 0;

  if (lastAssistant?.complete && implementationExpected && !implementationApplied) {
    return {
      phase: "failed",
      label: "未产生代码变更",
      detail: "Agent 已结束回答，但当前工作区没有检测到本轮落盘的代码。",
      toolCount: calls.length,
      completedToolCount,
      failedToolCount: failedCalls.length,
      consecutiveProtocolFailures,
      issue: {
        code: "no_changes",
        title: "模型只返回了说明，没有完成实施",
        detail: calls.length === 0
          ? "这是一个实施型需求，但模型未调用任何工程工具。聊天中的代码块不代表文件已创建。"
          : `本轮执行了 ${calls.length} 项工程操作，但未检测到真实文件变更。`,
        action: "使用 Craft 新建干净会话重试；如果仍只返回代码块，请换用支持工具调用的编程模型。",
        severity: "error",
      },
    };
  }

  return {
    phase: hasAssistantText || completedToolCount > 0 ? "completed" : "idle",
    label: hasAssistantText || completedToolCount > 0 ? "本轮已完成" : "等待开始",
    detail: hasAssistantText || completedToolCount > 0 ? "请审查代码变更并运行验证。" : "输入开发需求开始工作。",
    toolCount: calls.length,
    completedToolCount,
    failedToolCount: failedCalls.length,
    consecutiveProtocolFailures,
  };
}

function gitFileFingerprint(file: CodingGitSnapshot["files"][number]): string {
  return [file.status, file.staged, file.unstaged, file.untracked, file.added, file.removed].join(":");
}

export function codingChangedFilesSinceBaseline(
  current: CodingGitSnapshot | null,
  baseline?: CodingGitSnapshot,
): { agent: string[]; preExisting: string[] } {
  const before = new Map((baseline?.files ?? []).map((file) => [file.path, gitFileFingerprint(file)]));
  const agent: string[] = [];
  const preExisting: string[] = [];
  for (const file of current?.files ?? []) {
    if (!before.has(file.path)) agent.push(file.path);
    else {
      preExisting.push(file.path);
      if (before.get(file.path) !== gitFileFingerprint(file)) agent.push(file.path);
    }
  }
  return { agent, preExisting };
}

const SNAPSHOT_PREFIX = "echo-coding-workspace:";

/**
 * Coding commands run with the repository as cwd, so deleting `.` or `..` is
 * materially more dangerous here than in the shared read-only risk badge.
 * Keep this stricter policy scoped to the Coding Workspace.
 */
export function checkCodingCommandRisk(command: string): CommandRiskResult {
  const shared = checkCommandRisk(command);
  if (shared.level === "high") return shared;
  for (const segment of command.toLowerCase().split(/[;&|]/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    const rmIndex = tokens.findIndex((token) => token === "rm" || token === "\\rm" || token.endsWith("/rm"));
    if (rmIndex < 0) continue;
    const args = tokens.slice(rmIndex + 1);
    const recursive = args.some((token) => token === "--recursive" || /^-[a-z]*r[a-z]*$/i.test(token));
    const force = args.some((token) => token === "--force" || /^-[a-z]*f[a-z]*$/i.test(token));
    const deletesWorkingTree = args
      .filter((token) => !token.startsWith("-"))
      .map((token) => token.replace(/^['"]|['"]$/g, "").replace(/\/+$/, ""))
      .some((target) => [".", "..", "./", "$pwd", "${pwd}", "$(pwd)", "`pwd`", "%cd%"]
        .includes(target.toLowerCase()));
    if (recursive && force && deletesWorkingTree) {
      return { level: "high", reasons: ["禁止递归强制删除当前代码库或其父目录"] };
    }
  }
  return shared;
}

function stableCriterionId(index: number, content: string): string {
  let hash = 0;
  for (let cursor = 0; cursor < content.length; cursor++) {
    hash = (hash * 31 + content.charCodeAt(cursor)) | 0;
  }
  return `ac-${index + 1}-${Math.abs(hash).toString(36)}`;
}

export function createAcceptanceCriteria(raw: string): AcceptanceCriterion[] {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim())
    .filter(Boolean);
  const unique = [...new Set(lines)];
  const normalized = unique.length > 0
    ? unique
    : [
        "需求涉及的业务流程能够完整运行",
        "修改范围符合需求且没有无关变更",
        "新增或修改的自动化测试全部通过",
        "失败场景、幂等性和异常处理得到验证",
        "已核对 Git Diff，现有功能未受到意外影响",
      ];
  if (!normalized.some((line) => /测试|test/i.test(line))) {
    normalized.push("新增或修改的自动化测试全部通过");
  }
  return normalized.map((content, index) => ({
    id: stableCriterionId(index, content),
    content,
    verified: false,
  }));
}

function parseMetadata(content: string, key: string): string[] {
  const expression = new RegExp(`\\[${key}:([^\\]]+)\\]`, "i");
  const match = content.match(expression);
  if (!match) return [];
  const raw = match[1].trim();
  if (/^(none|无|-)$/.test(raw.toLowerCase())) return [];
  return raw.split(/[,，]/).map((value) => value.trim()).filter(Boolean);
}

function stripTaskMetadata(content: string): string {
  return content
    .replace(/\[T[\w-]+\]/gi, "")
    .replace(/\[(?:depends|files):[^\]]+\]/gi, "")
    .trim();
}

export function deriveTaskNodes(plan: Plan | null): CodingTaskNode[] {
  if (!plan) return [];
  const tasks: CodingTaskNode[] = [];
  plan.entries.forEach((entry, index) => {
    const declaredId = entry.content.match(/\[(T[\w-]+)\]/i)?.[1];
    const id = declaredId?.toUpperCase() ?? `T${index + 1}`;
    const dependencies = parseMetadata(entry.content, "depends").map((value) => value.toUpperCase());
    tasks.push({
      id,
      content: stripTaskMetadata(entry.content) || entry.content,
      dependencies: dependencies.length > 0 || index === 0 ? dependencies : [tasks[index - 1].id],
      relatedFiles: parseMetadata(entry.content, "files"),
      status: entry.status,
      priority: entry.priority,
    });
  });
  return tasks;
}

/**
 * Treat documentation as evidence only when it contains the expected semantic
 * structure. File existence alone is intentionally insufficient for a bid
 * gate, because an empty or placeholder document proves nothing.
 */
export function isDocumentationLevelSatisfied(level: CodingDocLevel, content: string): boolean {
  const normalized = content.trim();
  if (normalized.length < 120 || !/^#{1,6}\s+\S+/m.test(normalized)) return false;
  const requirements: Record<CodingDocLevel, RegExp[]> = {
    function: [
      /\b(function|method|responsibilit(?:y|ies))\b|函数|方法|职责/i,
      /\b(input|parameter|output|return|contract)\b|输入|参数|输出|返回|契约/i,
      /\b(exception|error|business rule|constraint)\b|异常|错误|业务规则|约束/i,
    ],
    module: [
      /\b(module|component|responsibilit(?:y|ies))\b|模块|组件|职责/i,
      /\b(dependenc(?:y|ies)|call sequence|interface)\b|依赖|调用顺序|接口/i,
      /\b(business rule|failure|idempoten)\w*\b|业务规则|失败|幂等/i,
    ],
    system: [
      /\b(system|architecture)\b|系统|架构/i,
      /\b(module|service|flow|call)\b|模块|服务|流程|调用/i,
      /\b(consisten|compensat|boundary|idempoten)\w*\b|一致性|补偿|边界|幂等/i,
    ],
  };
  return requirements[level].every((pattern) => pattern.test(normalized));
}

export function buildCodingAgentPrompt(
  requirement: string,
  criteria: AcceptanceCriterion[],
  analysis?: CodingWorkspaceAnalysis | null,
  options: {
    mode?: CodingAgentMode;
    contextPaths?: string[];
    baselineGit?: CodingGitSnapshot | null;
  } = {},
): string {
  const mode = options.mode ?? "plan";
  const moduleContext = analysis?.modules.length
    ? analysis.modules.map((module) => `- ${module.name} (${module.kind}, ${module.path})`).join("\n")
    : "- 请自行扫描并识别工程模块";
  const acceptance = criteria.map((criterion, index) => `AC${index + 1}. ${criterion.content}`).join("\n");
  const rules = (analysis?.instructionFiles ?? []).length
    ? analysis!.instructionFiles.map((path) => `- ${path}`).join("\n")
    : "- 未预先发现规则文件，仍需检查目标目录的局部指令";
  const validations = analysis?.validationCommands.length
    ? analysis.validationCommands.map((command) => `- ${command}`).join("\n")
    : "- 请根据工程构建文件选择可靠的验证命令";
  const selectedContext = options.contextPaths?.length
    ? options.contextPaths.map((path) => `- ${path}`).join("\n")
    : "- 未指定；请从需求、工程规则和代码搜索中选择最小充分上下文";
  const existingChanges = options.baselineGit?.files.length
    ? options.baselineGit.files.map((file) => `- ${file.path}（任务开始前已${file.status}）`).join("\n")
    : "- 无已知的任务前 Git 变更";
  const modeProtocol: Record<CodingAgentMode, string[]> = {
    ask: [
      "当前为 Ask 模式：只读取、搜索、解释和给出建议，不写文件、不执行会改变工作区状态的命令。",
      "结论必须引用具体文件或符号；信息不足时明确指出还需读取什么。",
    ],
    craft: [
      "当前为 Craft 模式：适合目标明确的小范围任务，可在理解相关代码后直接修改，不需要提交 Plan 审批。",
      "如果需求要求创建、修改或修复代码，必须使用工具把结果写入当前工作区；不得只在聊天中返回示例代码。",
      "控制修改范围，完成后必须展示变更摘要并执行最相关的验证。",
    ],
    plan: [
      "当前为 Plan 模式：任何写入前必须提交结构化计划并等待用户批准。",
      "每项计划使用 `[T1][depends:none][files:path1,path2] 描述`，标明依赖、预计文件和验证方式。",
    ],
  };
  return [
    "你是 EchoAgent 代码开发工作台的资深工程 Agent。目标是交付可运行、可验证、可审查的代码，不是输出示例或只给建议。",
    "",
    "## 原始需求",
    requirement.trim(),
    "",
    "## 当前识别的模块",
    moduleContext,
    "",
    "## 已发现的工程规则",
    rules,
    "",
    "## 用户选定的上下文",
    selectedContext,
    "",
    "## 任务开始前的未提交变更（必须保护）",
    existingChanges,
    "",
    "## 建议质量验证",
    validations,
    "",
    "## 验收标准",
    acceptance,
    "",
    "## 必须遵守的执行协议",
    "1. 先读取适用的 AGENTS.md/工程规则、构建文件、相关符号与测试，必要时使用代码搜索或代码库图确认调用关系。",
    "2. 优先启用与当前技术栈匹配的已安装 Coding Skill；Skill 只提供工程约束，代码读写、命令、权限与取消仍由当前 Agent Runtime 统一执行。",
    ...modeProtocol[mode].map((rule, index) => `${index + 3}. ${rule}`),
    "5. 每次工具调用必须携带符合工具 schema 的完整 JSON arguments。调用 list_dir 必须包含 target_directory，read_file 必须包含 target_file，run_terminal_command 必须包含 command；不得提交空 arguments，连续失败时立即停止并说明模型兼容问题。",
    "6. 尽量使用小范围 apply_patch；修改前重读目标区域，不覆盖任务开始前已有的未提交改动，不修改与需求无关的功能。",
    "7. 生成代码必须遵循现有架构、命名、错误处理和安全约定；优先复用现有抽象，不引入无必要依赖。",
    "8. 变更后执行适用的格式化、类型/编译检查、静态检查和测试；只能根据真实退出码声明通过。",
    "9. 实施型需求的完成条件是文件已真实落盘且已执行至少一项最相关验证；只输出代码块、只建议用户自行保存，或未读取真实工程都不算完成。",
    "10. 验证失败时先定位根因，再做最小修复；最多自动修复 3 轮，仍失败则保留日志并报告阻塞。",
    "11. 仅当公开接口、复杂业务规则或架构确有变更时更新相关源码注释与项目文档；禁止生成重复代码字面含义的废话注释。",
    "12. 最终逐条核对验收标准，列出 Git 变更、执行命令、测试结果和剩余风险；未运行的验证必须明确标记。",
  ].join("\n");
}

export function buildDocumentationPrompt(requirement: string): string {
  return [
    "请基于当前已经落盘并通过验证的代码生成代码开发工作台所需的三级文档。",
    `原始需求：${requirement.trim()}`,
    "不要臆测不存在的行为；先读取真实符号、调用关系、测试和构建结果。",
    "先为本次变更中的公开接口和复杂业务函数补充源码文档注释，说明职责、参数/返回、异常和业务约束；不生成重复代码字面含义的废话注释。",
    `函数级文档写入 ${CODING_DOC_PATHS.function}，覆盖关键函数的职责、输入、输出、异常和业务约束。`,
    `模块级文档写入 ${CODING_DOC_PATHS.module}，覆盖模块职责、接口、依赖、调用顺序和业务规则。`,
    `系统级文档写入 ${CODING_DOC_PATHS.system}，覆盖系统架构、跨模块流程、数据一致性、失败补偿和边界。`,
    "三个层级必须使用相同术语，并互相链接。完成后检查三个文件都已创建。",
  ].join("\n");
}

export function buildCodingFollowupPrompt(
  text: string,
  mode: CodingAgentMode,
  contextPaths: string[],
): string {
  const contract = mode === "ask"
    ? "Ask 模式：只读分析，不修改文件或运行会改变工作区状态的命令。"
    : mode === "craft"
      ? "Craft 模式：针对当前要求直接完成最小范围修改，并验证真实结果。"
      : "Plan 模式：若要求改变实施范围，先更新计划并等待批准，再继续修改。";
  return [
    `<coding-mode>${mode}</coding-mode>`,
    contract,
    mode === "craft" ? "实施型要求必须使用工具写入当前工作区并运行验证，不得只返回可复制的示例代码。" : "",
    contextPaths.length > 0 ? `优先检查这些上下文：${contextPaths.join("、")}` : "",
    "工具调用必须提供符合 schema 的完整 JSON 参数；如果当前模型无法提供工具参数，立即停止并明确报告兼容问题。",
    "",
    text.trim(),
  ].filter(Boolean).join("\n");
}

export function commandLabel(command: string): string {
  const normalized = command.toLowerCase();
  if (/\b(test|pytest|jest|vitest)\b/.test(normalized)) return "自动化测试";
  if (/\b(build|compile|package|check)\b/.test(normalized)) return "构建检查";
  if (/\b(lint|eslint|clippy)\b/.test(normalized)) return "静态检查";
  return "终端命令";
}

export function validationFromResult(
  result: CodingCommandResult,
  startedAt: string,
  source: ValidationRecord["source"] = "workspace",
): ValidationRecord {
  const combined = `${result.stdout}\n${result.stderr}`;
  const summaries = [
    combined.match(/Tests run:\s*\d+(?:,\s*Failures:\s*\d+)?(?:,\s*Errors:\s*\d+)?/i)?.[0],
    combined.match(/\d+\s+(?:tests?|passed)(?:\s+passed)?/i)?.[0],
    combined.match(/test result:\s*(?:ok|FAILED)[^\n]*/i)?.[0],
  ].filter(Boolean);
  return {
    id: `validation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    command: result.command,
    label: commandLabel(result.command),
    status: result.cancelled ? "cancelled" : result.timedOut ? "timed_out" : result.exitCode === 0 ? "passed" : "failed",
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs,
    startedAt,
    finishedAt: new Date().toISOString(),
    testSummary: summaries[0],
    truncated: result.truncated,
    source,
  };
}

export function collectAgentValidations(messages: ChatMessage[]): ValidationRecord[] {
  const records: ValidationRecord[] = [];
  messages.forEach((message) => {
    message.parts.forEach((part) => {
      if (part.kind !== "tool_call") return;
      part.toolCall.content.forEach((content, contentIndex) => {
        if (content.type !== "command_output" || !content.command) return;
        const label = commandLabel(content.command);
        if (label === "终端命令") return;
        records.push({
          id: `agent-${part.toolCall.toolCallId}-${contentIndex}`,
          command: content.command,
          label,
          status: part.toolCall.status === "in_progress"
            ? "running"
            : content.exitCode === 0
              ? "passed"
              : "failed",
          exitCode: content.exitCode ?? null,
          stdout: content.output,
          stderr: "",
          durationMs: Math.max(0, (message.completedAt ?? Date.now()) - (message.startedAt ?? Date.now())),
          startedAt: new Date(message.startedAt ?? Date.now()).toISOString(),
          finishedAt: message.completedAt ? new Date(message.completedAt).toISOString() : undefined,
          testSummary: validationFromText(content.output),
          source: "agent",
        });
      });
    });
  });
  return records;
}

function validationFromText(output: string): string | undefined {
  return output.match(/Tests run:\s*\d+(?:,\s*Failures:\s*\d+)?(?:,\s*Errors:\s*\d+)?/i)?.[0]
    ?? output.match(/\d+\s+(?:tests?|passed)(?:\s+passed)?/i)?.[0]
    ?? output.match(/test result:\s*(?:ok|FAILED)[^\n]*/i)?.[0];
}

function changedModuleNames(analysis: CodingWorkspaceAnalysis | null, paths: string[]): string[] {
  if (!analysis) return [];
  return analysis.modules
    .filter((module) => {
      if (module.path === ".") return analysis.modules.length === 1 && paths.length > 0;
      const normalized = `${module.path.replace(/\\/g, "/").replace(/\/$/, "")}/`;
      return paths.some((path) => path.replace(/\\/g, "/").includes(normalized));
    })
    .map((module) => module.name);
}

export function deriveQualityGates(options: {
  analysis: CodingWorkspaceAnalysis | null;
  plan: Plan | null;
  messages: ChatMessage[];
  validations: ValidationRecord[];
  git: CodingGitSnapshot | null;
  criteria: AcceptanceCriterion[];
  reviewedFiles?: string[];
  mode?: CodingAgentMode;
}): QualityGate[] {
  const mode = options.mode ?? "plan";
  const changedFiles = options.git?.files ?? [];
  const changedModules = changedModuleNames(options.analysis, changedFiles.map((file) => file.path));
  const tasks = deriveTaskNodes(options.plan);
  const allValidations = [...options.validations, ...collectAgentValidations(options.messages)];
  const latestByCommand = new Map<string, ValidationRecord>();
  [...allValidations]
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
    .forEach((record) => latestByCommand.set(record.command.trim().toLowerCase(), record));
  const latestValidations = [...latestByCommand.values()];
  const expectedCommands = options.analysis?.validationCommands ?? [];
  const latestPassedCommands = new Set(
    latestValidations
      .filter((record) => record.status === "passed")
      .map((record) => record.command.trim().toLowerCase()),
  );
  const expectedPassed = expectedCommands.length > 0
    && expectedCommands.every((command) => latestPassedCommands.has(command.trim().toLowerCase()));
  const anyValidationFailed = latestValidations.some((record) => record.status !== "passed");
  const validationsPassed = expectedCommands.length > 0
    ? expectedPassed && !anyValidationFailed
    : latestValidations.length > 0 && !anyValidationFailed;
  const hasStructuredDependencies = tasks.length > 1 && tasks.some((task) => task.dependencies.length > 0);
  const tasksComplete = tasks.length > 0 && tasks.every((task) => task.status === "completed");
  const acceptanceCount = options.criteria.filter((criterion) => criterion.verified).length;
  const acceptanceTotal = options.criteria.length;
  const acceptanceSatisfied = acceptanceTotal > 0 && acceptanceCount === acceptanceTotal;
  const acceptanceStatus = acceptanceSatisfied ? "satisfied" : acceptanceCount > 0 ? "in_progress" : "not_satisfied";
  const conflicts = changedFiles.filter((file) => file.status === "conflict");
  const substantiveChanges = changedFiles.filter((file) => file.status !== "ignored");
  const reviewed = new Set(options.reviewedFiles ?? substantiveChanges.map((file) => file.path));
  const reviewedChanges = substantiveChanges.filter((file) => reviewed.has(file.path));
  const completedAssistantTurn = options.messages.some((message) =>
    message.role === "assistant"
      && message.complete
      && message.parts.some((part) => part.kind === "text" ? part.text.trim().length > 0 : part.kind === "tool_call"));
  const workflowStatus: QualityGate["status"] = mode === "plan"
    ? tasksComplete && (tasks.length === 1 || hasStructuredDependencies)
      ? "satisfied"
      : tasks.length > 0 ? "in_progress" : "not_satisfied"
    : mode === "craft"
      ? completedAssistantTurn && substantiveChanges.length > 0
        ? "satisfied"
        : options.messages.length > 0 || substantiveChanges.length > 0 ? "in_progress" : "not_satisfied"
      : completedAssistantTurn
        ? "satisfied"
        : options.messages.length > 0 ? "in_progress" : "not_satisfied";
  const workflowTitle = mode === "plan" ? "计划与执行闭环" : mode === "craft" ? "实施与交付闭环" : "只读分析闭环";
  const workflowSummary = mode === "plan"
    ? `${tasks.length} 个任务节点，${tasks.filter((task) => task.status === "completed").length} 个已完成`
    : mode === "craft"
      ? completedAssistantTurn && substantiveChanges.length > 0 ? `Agent 已交付 ${substantiveChanges.length} 个变更文件` : "等待 Agent 完成代码修改与结果总结"
      : completedAssistantTurn ? "Agent 已完成只读分析并返回结论" : "等待 Agent 返回可引用的代码分析";

  return [
    {
      id: "change_review",
      title: "真实变更可审查",
      status: substantiveChanges.length > 0 && reviewedChanges.length === substantiveChanges.length
        ? "satisfied"
        : substantiveChanges.length > 0 ? "in_progress" : "not_satisfied",
      summary: substantiveChanges.length > 0
        ? `已审查 ${reviewedChanges.length}/${substantiveChanges.length} 个 Git 变更文件，覆盖 ${changedModules.length || 1} 个范围`
        : "Git 工作区尚无可审查变更",
      evidence: [
        ...substantiveChanges.slice(0, 10).map((file) => `${file.path}（${file.status}，+${file.added}/-${file.removed}）`),
        ...changedModules.map((module) => `模块：${module}`),
      ],
    },
    {
      id: "planning",
      title: workflowTitle,
      status: workflowStatus,
      summary: workflowSummary,
      evidence: mode === "plan"
        ? tasks.slice(0, 10).map((task) => `${task.id}${task.dependencies.length ? ` ← ${task.dependencies.join(", ")}` : ""}：${task.content}`)
        : completedAssistantTurn ? [`${mode === "ask" ? "Ask" : "Craft"} Agent 已结束当前轮次`] : [],
    },
    {
      id: "validation",
      title: "工程质量验证",
      status: validationsPassed
        ? "satisfied"
        : allValidations.length > 0 ? "in_progress" : "not_satisfied",
      summary: expectedCommands.length > 0
        ? `${expectedCommands.filter((command) => latestPassedCommands.has(command.trim().toLowerCase())).length}/${expectedCommands.length} 项建议验证已通过`
        : `${latestValidations.filter((record) => record.status === "passed").length}/${latestValidations.length} 项最新验证通过`,
      evidence: allValidations.slice(-8).map((record) => `${record.command} → ${record.status}${record.testSummary ? ` · ${record.testSummary}` : ""}`),
    },
    {
      id: "conflicts",
      title: "冲突与安全检查",
      status: changedFiles.length > 0 && conflicts.length === 0 ? "satisfied" : conflicts.length > 0 ? "in_progress" : "not_satisfied",
      summary: conflicts.length === 0 ? "未检测到 Git 合并冲突" : `存在 ${conflicts.length} 个冲突文件，不能交付`,
      evidence: conflicts.length > 0
        ? conflicts.map((file) => file.path)
        : changedFiles.length > 0 ? ["Git status 未发现 unmerged 文件"] : [],
    },
    {
      id: "acceptance",
      title: "需求逐条验收",
      status: acceptanceStatus,
      summary: `${acceptanceCount}/${acceptanceTotal} 条验收标准已由用户核对`,
      evidence: options.criteria
        .filter((criterion) => criterion.verified)
        .map((criterion) => criterion.content),
    },
  ];
}

export function buildVerificationReport(options: {
  snapshot: CodingRunSnapshot;
  analysis: CodingWorkspaceAnalysis | null;
  evidence: QualityGate[];
  tasks: CodingTaskNode[];
  changedFiles: CodingGitSnapshot | null;
}): string {
  const { snapshot, analysis, evidence, tasks, changedFiles } = options;
  const statusLabel = { satisfied: "满足", in_progress: "验证中", not_satisfied: "未满足" } as const;
  return [
    "# EchoAgent 代码开发能力验收报告",
    "",
    `- 生成时间：${new Date().toLocaleString()}`,
    `- 工作区：${snapshot.root}`,
    `- Repository：${analysis?.name ?? "未识别"}`,
    `- Branch：${analysis?.gitBranch ?? "非 Git 工作区"}`,
    `- Agent Session：${snapshot.sessionId ?? "未启动"}`,
    "",
    "## 原始需求",
    "",
    snapshot.requirement || "未填写",
    "",
    "## 验收标准",
    "",
    ...snapshot.acceptanceCriteria.map((criterion) => `- [${criterion.verified ? "x" : " "}] ${criterion.content}`),
    "",
    "## 质量门禁",
    "",
    ...evidence.flatMap((item, index) => [
      `### ${index + 1}. ${item.title}：${statusLabel[item.status]}`,
      "",
      item.summary,
      "",
      ...(item.evidence.length ? item.evidence.map((entry) => `- ${entry}`) : ["- 暂无可验证证据"]),
      "",
    ]),
    "## 任务执行",
    "",
    ...tasks.map((task) => `- [${task.status === "completed" ? "x" : " "}] ${task.id} ${task.content}${task.dependencies.length ? `（依赖：${task.dependencies.join(", ")}）` : ""}`),
    "",
    "## 文件变更",
    "",
    `共 ${changedFiles?.files.length ?? 0} 个文件，新增 ${changedFiles?.totalAdded ?? 0} 行，删除 ${changedFiles?.totalRemoved ?? 0} 行。`,
    "",
    ...(changedFiles?.files ?? []).map((file) => `- ${file.path}（${file.status}，+${file.added}/-${file.removed}）`),
    "",
    "## 验证记录",
    "",
    ...snapshot.validationRecords.map((record) => `- ${record.command}：${record.status}，退出码 ${record.exitCode ?? "无"}，耗时 ${record.durationMs}ms${record.testSummary ? `，${record.testSummary}` : ""}`),
    "",
    "> 本报告仅依据当前 Git 状态、已批准的 Agent 计划、真实命令退出码和用户验收记录生成；未执行的检查不会被标记为通过。",
  ].join("\n");
}

function snapshotKey(root: string): string {
  return `${SNAPSHOT_PREFIX}${encodeURIComponent(root)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeStoredCriteria(value: unknown): AcceptanceCriterion[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => isRecord(item) && typeof item.content === "string" && item.content.trim().length > 0)
    .slice(0, 200)
    .map((item, index) => ({
      id: typeof item.id === "string" && item.id ? item.id : stableCriterionId(index, item.content as string),
      content: (item.content as string).trim(),
      verified: item.verified === true,
    }));
}

function normalizeStoredValidations(value: unknown): ValidationRecord[] {
  if (!Array.isArray(value)) return [];
  const statuses = new Set<ValidationRecord["status"]>(["running", "passed", "failed", "timed_out", "cancelled"]);
  return value
    .filter((item): item is Record<string, unknown> => isRecord(item)
      && typeof item.command === "string"
      && typeof item.startedAt === "string")
    .slice(-50)
    .map((item, index) => ({
      id: typeof item.id === "string" && item.id ? item.id : `stored-validation-${index}`,
      command: item.command as string,
      label: typeof item.label === "string" ? item.label : commandLabel(item.command as string),
      status: statuses.has(item.status as ValidationRecord["status"])
        ? item.status as ValidationRecord["status"]
        : "failed",
      exitCode: typeof item.exitCode === "number" ? item.exitCode : null,
      stdout: typeof item.stdout === "string" ? item.stdout.slice(-32_000) : "",
      stderr: typeof item.stderr === "string" ? item.stderr.slice(-32_000) : "",
      durationMs: typeof item.durationMs === "number" && Number.isFinite(item.durationMs)
        ? Math.max(0, item.durationMs)
        : 0,
      startedAt: item.startedAt as string,
      finishedAt: typeof item.finishedAt === "string" ? item.finishedAt : undefined,
      testSummary: typeof item.testSummary === "string" ? item.testSummary : undefined,
      truncated: item.truncated === true,
      source: item.source === "agent" ? "agent" : "workspace",
    }));
}

function normalizeStoredGitSnapshot(value: unknown): CodingGitSnapshot | undefined {
  if (!isRecord(value) || !Array.isArray(value.files)) return undefined;
  const statuses = new Set<CodingGitSnapshot["files"][number]["status"]>([
    "modified", "added", "deleted", "renamed", "untracked", "conflict", "ignored",
  ]);
  const files = value.files
    .filter((item): item is Record<string, unknown> => isRecord(item) && typeof item.path === "string")
    .slice(0, 5_000)
    .map((item) => ({
      path: item.path as string,
      oldPath: typeof item.oldPath === "string" ? item.oldPath : undefined,
      status: statuses.has(item.status as CodingGitSnapshot["files"][number]["status"])
        ? item.status as CodingGitSnapshot["files"][number]["status"]
        : "modified" as const,
      staged: item.staged === true,
      unstaged: item.unstaged === true,
      untracked: item.untracked === true,
      added: typeof item.added === "number" ? Math.max(0, item.added) : 0,
      removed: typeof item.removed === "number" ? Math.max(0, item.removed) : 0,
    }));
  return {
    hasGit: value.hasGit === true,
    branch: typeof value.branch === "string" ? value.branch : undefined,
    head: typeof value.head === "string" ? value.head : undefined,
    files,
    totalAdded: typeof value.totalAdded === "number" ? Math.max(0, value.totalAdded) : 0,
    totalRemoved: typeof value.totalRemoved === "number" ? Math.max(0, value.totalRemoved) : 0,
    capturedAt: typeof value.capturedAt === "string" ? value.capturedAt : "",
  };
}

export function loadCodingSnapshot(root: string): CodingRunSnapshot | null {
  if (!root) return null;
  try {
    const parsed = JSON.parse(localStorage.getItem(snapshotKey(root)) ?? "null") as unknown;
    if (!isRecord(parsed) || parsed.root !== root || (parsed.version !== 1 && parsed.version !== 2)) return null;
    return {
      version: 2,
      root,
      requirement: typeof parsed.requirement === "string" ? parsed.requirement : "",
      acceptanceCriteria: normalizeStoredCriteria(parsed.acceptanceCriteria),
      validationRecords: normalizeStoredValidations(parsed.validationRecords),
      sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : undefined,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : undefined,
      docLevels: Array.isArray(parsed.docLevels)
        ? parsed.docLevels.filter((level): level is CodingDocLevel => level === "function" || level === "module" || level === "system")
        : [],
      mode: parsed.mode === "ask" || parsed.mode === "craft" || parsed.mode === "plan" ? parsed.mode : "craft",
      modelId: typeof parsed.modelId === "string" ? parsed.modelId : undefined,
      contextPaths: Array.isArray(parsed.contextPaths)
        ? parsed.contextPaths.filter((path): path is string => typeof path === "string").slice(0, 30)
        : [],
      reviewedFiles: Array.isArray(parsed.reviewedFiles)
        ? parsed.reviewedFiles.filter((path): path is string => typeof path === "string").slice(0, 2_000)
        : [],
      baselineGit: normalizeStoredGitSnapshot(parsed.baselineGit),
    };
  } catch {
    return null;
  }
}

export function saveCodingSnapshot(snapshot: CodingRunSnapshot): void {
  const bounded: CodingRunSnapshot = {
    ...snapshot,
    validationRecords: snapshot.validationRecords.slice(-50).map((record) => ({
      ...record,
      stdout: record.stdout.slice(-32_000),
      stderr: record.stderr.slice(-32_000),
    })),
    contextPaths: snapshot.contextPaths.slice(-30),
    reviewedFiles: snapshot.reviewedFiles.slice(-2_000),
    baselineGit: snapshot.baselineGit
      ? { ...snapshot.baselineGit, files: snapshot.baselineGit.files.slice(0, 5_000) }
      : undefined,
  };
  try {
    localStorage.setItem(snapshotKey(snapshot.root), JSON.stringify(bounded));
  } catch {
    // A large dirty repository or verbose validation output can exceed the
    // WebView quota. Preserve the resumable task contract without crashing the
    // coding UI; live Git state and full logs remain available in memory.
    try {
      localStorage.setItem(snapshotKey(snapshot.root), JSON.stringify({
        ...bounded,
        validationRecords: bounded.validationRecords.map((record) => ({
          ...record,
          stdout: record.stdout.slice(-2_000),
          stderr: record.stderr.slice(-2_000),
        })),
        baselineGit: bounded.baselineGit
          ? { ...bounded.baselineGit, files: bounded.baselineGit.files.slice(0, 500) }
          : undefined,
      }));
    } catch {
      // Storage may be disabled. The in-memory session continues to work.
    }
  }
}
