import type { Plan, PlanEntry } from "@/lib/types";

import type { RuntimePlanEntry, TaskNodeStatus } from "./types";

type ContractField =
  | "dependencies"
  | "relatedFiles"
  | "readSet"
  | "writeSet"
  | "consumes"
  | "produces"
  | "acceptanceCriteria"
  | "verificationCommands";

const FIELD_ALIASES: Array<[RegExp, ContractField]> = [
  [/^(?:depends(?:\s+on)?|依赖)\s*[:：]\s*(.*)$/i, "dependencies"],
  [/^(?:reads?|read\s*set|读取文件|只读)\s*[:：]\s*(.*)$/i, "readSet"],
  [/^(?:writes?|write\s*set|写入文件|修改文件)\s*[:：]\s*(.*)$/i, "writeSet"],
  [/^(?:files?|文件)\s*[:：]\s*(.*)$/i, "relatedFiles"],
  [/^(?:consumes?|消费接口|依赖接口)\s*[:：]\s*(.*)$/i, "consumes"],
  [/^(?:produces?|产出接口|提供接口|输出接口)\s*[:：]\s*(.*)$/i, "produces"],
  [/^(?:acceptance|验收|完成条件)\s*[:：]\s*(.*)$/i, "acceptanceCriteria"],
  [/^(?:verify|verification|验证|检查命令)\s*[:：]\s*(.*)$/i, "verificationCommands"],
];

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function splitValues(value: string, command = false): string[] {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "-" || trimmed.toLowerCase() === "none" || trimmed === "无") {
    return [];
  }
  if (command) return [trimmed];
  return unique(trimmed.split(/\s*[,，、]\s*/));
}

function planKey(content: string, index: number): string {
  const explicit = content.match(/^\s*\[([A-Za-z][A-Za-z0-9_-]{0,31})\]/)?.[1]
    ?? content.match(/^\s*(T\d+)\s*[:：.\-]/i)?.[1];
  return explicit?.toUpperCase() ?? `T${index + 1}`;
}

function toNodeStatus(entry: PlanEntry): TaskNodeStatus {
  if (entry.status === "completed") return "success";
  if (entry.status === "in_progress") return "running";
  return "pending";
}

/**
 * Convert ACP's display-oriented Plan into the execution contract persisted by
 * the coding orchestrator. Unstructured plans receive stable T1..Tn keys and
 * conservative sequential dependencies, but the native validator will still
 * request the missing file, acceptance and verification contracts before any
 * complex task may proceed.
 */
export function parseRuntimePlan(plan: Plan): RuntimePlanEntry[] {
  const keys = plan.entries.map((entry, index) => planKey(entry.content, index));
  return plan.entries.map((entry, index) => {
    const fields: Record<ContractField, string[]> = {
      dependencies: [],
      relatedFiles: [],
      readSet: [],
      writeSet: [],
      consumes: [],
      produces: [],
      acceptanceCriteria: [],
      verificationCommands: [],
    };
    let dependencyDeclared = false;
    const goalLines: string[] = [];
    const lines = entry.content
      .replace(/\s+\|\s+(?=(?:Depends|Files?|Reads?|Writes?|Consumes?|Produces?|Acceptance|Verify|依赖|文件|验收|验证)\s*[:：])/gi, "\n")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    for (const rawLine of lines) {
      const line = rawLine.replace(/^[-*]\s+/, "");
      const match = FIELD_ALIASES
        .map(([pattern, field]) => ({ match: line.match(pattern), field }))
        .find((candidate) => candidate.match);
      if (!match?.match) {
        goalLines.push(line);
        continue;
      }
      if (match.field === "dependencies") dependencyDeclared = true;
      fields[match.field].push(...splitValues(
        match.match[1] ?? "",
        match.field === "verificationCommands",
      ));
    }

    const key = keys[index];
    const content = (goalLines.join(" ") || entry.content)
      .replace(/^\s*\[[A-Za-z][A-Za-z0-9_-]{0,31}\]\s*[:：.\-]?\s*/, "")
      .replace(/^\s*T\d+\s*[:：.\-]\s*/i, "")
      .trim();
    const dependencies = dependencyDeclared
      ? unique(fields.dependencies.map((dependency) => dependency.toUpperCase()))
      : index > 0 ? [keys[index - 1]] : [];
    const relatedFiles = unique([
      ...fields.relatedFiles,
      ...fields.readSet,
      ...fields.writeSet,
    ]);
    // `Files` is the common concise form and therefore means planned writes;
    // an explicit Writes field takes precedence when one is present.
    const writeSet = unique(fields.writeSet.length > 0 ? fields.writeSet : fields.relatedFiles);

    return {
      key,
      content,
      dependencies,
      relatedFiles,
      readSet: unique(fields.readSet),
      writeSet,
      consumes: unique(fields.consumes),
      produces: unique(fields.produces),
      acceptanceCriteria: unique(fields.acceptanceCriteria),
      verificationCommands: unique(fields.verificationCommands),
      status: toNodeStatus(entry),
      priority: entry.priority,
    };
  });
}

export function runtimePlanFingerprint(plan: Plan | null): string {
  return plan ? JSON.stringify(parseRuntimePlan(plan)) : "";
}
