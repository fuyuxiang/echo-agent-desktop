/**
 * 团队状态派生纯函数 —— 从会话 transcript 解析 create_team 工具调用，
 * 提取已创建的团队与成员信息。
 *
 * EchoAgent 通过内嵌 MCP server（src-tauri/src/team_mcp.rs）提供
 * echoagent__create_team / team_status / team_delete 工具（旧会话历史里是
 * 无前缀的原生名，两者都识别），由 LLM 调用。这里从 tool_call 的
 * rawInput + content（工具结果）派生出「当前已创建的团队列表」供
 * TeamStatusView 展示。纯函数、无副作用。
 */
import type { ChatMessage, ToolCallView } from "@/stores/session-store";

/** 一个已创建的团队。 */
export interface TeamInfo {
  /** toolCallId（去重 key）。 */
  id: string;
  /** 团队 ID（来自 rawInput.team_id，按后端规则去除首尾空白）。 */
  teamId: string;
  /** 成员名称列表。 */
  members: string[];
  /** 创建时间（若能从结果解析）。 */
  createdAt?: number;
  /** 工具调用状态。 */
  status: "in_progress" | "completed" | "failed";
  /** Latest tool failure, if present in the transcript. */
  error?: string;
}

function inputObject(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw === "string") { try { raw = JSON.parse(raw); } catch { return undefined; } }
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
}

/** Unwrap the MCP dispatcher used by current runtimes. */
export function teamToolInput(tc: { rawInput?: unknown }): Record<string, unknown> | undefined {
  const object = inputObject(tc.rawInput);
  if (!object) return undefined;
  const input = object.tool_input ?? object.arguments;
  return input === undefined ? object : inputObject(input);
}

export function isTeamTool(tc: { kind: string; title: string; rawInput?: unknown; toolCallId: string }): boolean {
  const raw = inputObject(tc.rawInput);
  const dispatchedName = typeof raw?.tool_name === "string" ? raw.tool_name : "";
  return isCreateTeamTool(tc) || /(?:^|__|\s)team_(?:delete|status)(?:$|\s)/i.test(`${tc.kind} ${tc.title} ${dispatchedName}`);
}

/** 从会话消息派生已创建的团队列表（去重，按首次出现顺序）。 */
export function deriveTeams(messages: ChatMessage[]): TeamInfo[] {
  const seen = new Set<string>();
  const out: TeamInfo[] = [];
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.kind !== "tool_call") continue;
      const tc = p.toolCall;
      if (!isCreateTeamTool(tc)) continue;
      if (seen.has(tc.toolCallId)) continue;
      seen.add(tc.toolCallId);
      const info = parseTeamFromToolCall(tc);
      if (info) out.push(info);
    }
  }
  return out;
}

/** Keep conversation history intact; the status panel shows one latest attempt
 * per named team, including retries that are still running or later succeed. */
export function latestTeamAttempts(teams: TeamInfo[]): Array<TeamInfo & { attempts: number }> {
  const latest = new Map<string, TeamInfo & { attempts: number }>();
  for (const team of teams) {
    const key = team.teamId ? `team:${team.teamId}` : `call:${team.id}`;
    latest.set(key, { ...team, attempts: (latest.get(key)?.attempts ?? 0) + 1 });
  }
  return [...latest.values()];
}

/** 判断一个 tool_call 是否为 create_team。 */
export function isCreateTeamTool(tc: {
  kind: string;
  title: string;
  toolCallId: string;
  rawInput?: unknown;
}): boolean {
  const k = (tc.kind || "").toLowerCase();
  const dispatcher = inputObject(tc.rawInput);
  if (typeof dispatcher?.tool_name === "string" && /(?:^|__)create_team$/.test(dispatcher.tool_name)) return true;
  // 原生名（旧会话）或 MCP 限定名 echoagent__create_team（现行路径）。
  if (k === "create_team" || k === "team_create" || k === "echoagent__create_team") return true;
  const title = (tc.title || "").toLowerCase();
  if (title.includes("create_team") || title.includes("创建任务编组") || title.includes("创建专家团") || title.includes("创建团队")) return true;
  const obj = teamToolInput(tc);
  if (obj) {
    if ("team_id" in obj && "members" in obj) return true;
  }
  return false;
}

/** 从 create_team 工具调用解析团队信息。 */
function parseTeamFromToolCall(tc: ToolCallView): TeamInfo | null {
  const raw = teamToolInput(tc);
  if (!raw) return null;
  // Rust str::trim uses Unicode White_Space; JS trim differs for NEL and BOM.
  // Normalize here so retries, recovery and persisted snapshots share one ID.
  const teamId = typeof raw.team_id === "string"
    ? raw.team_id.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "")
    : "";
  let membersRaw = raw.members;
  if (typeof membersRaw === "string") {
    try { membersRaw = JSON.parse(membersRaw); } catch { membersRaw = undefined; }
  }
  // Match the backend's unambiguous singleton compatibility without inventing
  // names from schema objects or dictionaries. Legacy string arrays still work.
  if (inputObject(membersRaw)?.name) membersRaw = [membersRaw];
  let members: string[] = [];
  if (Array.isArray(membersRaw)) {
    members = membersRaw
      .map((mm) => {
        if (typeof mm === "string") return mm;
        if (mm && typeof mm === "object") {
          const obj = mm as Record<string, unknown>;
          return typeof obj.name === "string" ? obj.name : "";
        }
        return "";
      })
      .filter((s) => s.length > 0);
  }
  return {
    id: tc.toolCallId,
    teamId,
    members,
    status: tc.status,
    error: tc.status === "failed" ? tc.content
      .flatMap((part) => part.type === "text" && part.text.trim() ? [part.text.trim()] : [])
      .join("\n").slice(0, 2000) || undefined : undefined,
  };
}

/** 统计：返回团队总数与成员总数。 */
export function teamStats(teams: TeamInfo[]): {
  teamCount: number;
  memberCount: number;
} {
  return {
    teamCount: teams.length,
    memberCount: teams.reduce((sum, t) => sum + t.members.length, 0),
  };
}
