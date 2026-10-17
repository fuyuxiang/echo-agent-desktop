import { invoke } from "@tauri-apps/api/core";
import { isQuotaBlocking, loadQuotaConfig, loadUsage } from "@/lib/usage-quota";
import { listen } from "@tauri-apps/api/event";

export interface GroupMember { removed?: boolean; id: string; name: string; expert: string | null; role: string; modelId: string; sessionId: string | null; discussionSessionId: string | null; generation: number }
export interface GroupKnowledge { personal: boolean; organization: boolean; organizationScopeIds: string[]; context: string }
export interface GroupMessage { knowledge?: GroupKnowledge; id: string; seq: number; memberId: string | null; kind: string; text: string; createdAt: number; workId: string | null; replyTo: string | null; attachments: string[]; toolCalls: Record<string, unknown>[] }
export interface GroupWork { id: string; rootId: string; parentId: string | null; continuationOf: string | null; memberId: string; prompt: string; status: string; discussion: boolean; sessionId: string | null; output: string; error: string | null; createdAt: number; tokens: number }
export interface Group { id: string; name: string; goal: string; cwd: string; sourceSessionId: string | null; sourceTeamId: string | null; coordinatorId: string; members: GroupMember[]; messages: GroupMessage[]; works: GroupWork[]; decisions: { id: string; text: string; messageId: string | null; confirmed: boolean }[]; archived: boolean; pinned: boolean; paused: boolean; revision: number; updatedAt: number; maxCalls: number; tokenBudget: number }
export interface CreateGroupInput { coordinatorName?: string; coordinatorRole?: string; name: string; goal: string; cwd: string; modelId: string; members: string[]; sourceSessionId?: string; sourceTeamId?: string; referenceText?: string; roles?: Record<string, string>; models?: Record<string, string> }
export interface SendGroupInput { knowledge?: GroupKnowledge; id: string; text: string; memberIds: string[]; discussion: boolean; attachments: string[]; replyTo: string | null }
export const groupList = () => invoke<Group[]>("group_list");
export const groupSnapshot = (groupId: string) => invoke<Group>("group_snapshot", { groupId });
export const groupOwner = (sessionId: string) => invoke<string | null>("group_owner", { sessionId });
export async function resolveGroupForSession(sessionId: string, groups: Group[]): Promise<string | null> {
  const owner = groups.find(group => group.members.some(member => member.sessionId === sessionId || member.discussionSessionId === sessionId)
    || group.works.some(work => work.sessionId === sessionId));
  // The ordinary catalog includes hidden sessions, while group list previews
  // intentionally bound their work history. Always resolve a cache miss.
  return owner?.id ?? await groupOwner(sessionId) ?? null;
}
export const groupCreate = (input: CreateGroupInput) => invoke<Group>("group_create", { input });
export async function groupSend(groupId: string, input: SendGroupInput): Promise<void> {
  if (isQuotaBlocking(loadUsage(), loadQuotaConfig())) throw new Error("已达到 Token 配额，请先在“用量统计”中调整上限或策略");
  await invoke<void>("group_send", { groupId, input });
}
export const groupControl = (groupId: string, action: "pause" | "resume" | "stop" | "archive" | "pin" | "retry", workId?: string) => invoke<void>("group_control", { groupId, action, workId: workId ?? null });
export const groupSettings = (groupId: string, input: { name: string; goal: string; coordinatorId: string; maxCalls: number; tokenBudget: number; cwd?: string; members: { id: string; role: string; modelId: string }[] }) => invoke<void>("group_settings", { groupId, input });
export const onGroupChanged = (callback: (groupId: string) => void) => listen<{ groupId: string }>("group://changed", event => callback(event.payload.groupId));

export const terminalWork = (status: string) => ["completed", "failed", "cancelled"].includes(status);
export function mentionedMembers(text: string, members: GroupMember[]): string[] {
  const body = text.replace(/```[\s\S]*?```|`[^`]*`/g, " ");
  if (/(?:^|\s)@(?:全体|all)(?:$|[\s，,。；;：:！!？?])/i.test(body)) return members.filter(member => member.expert !== null && !member.removed).map(member => member.id);
  const spans: { start: number; end: number }[] = [], found: string[] = [];
  for (const member of members.filter(member => !member.removed).sort((a, b) => b.name.length - a.name.length)) {
    const escaped = member.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`(?:^|\\s)@${escaped}(?=$|[\\s，,。；;：:！!？?])`, "g");
    for (const match of body.matchAll(regex)) {
      const start = match.index! + match[0].indexOf("@");
      const end = start + member.name.length + 1;
      if (spans.some(span => start < span.end && end > span.start)) continue;
      spans.push({ start, end }); found.push(member.id);
    }
  }
  return [...new Set(found)];
}
export function groupRecipients(group: Group, text: string, explicit: string[], replyTo: string | null): string[] {
  const active = group.members.filter(member => !member.removed);
  const selected = [...new Set(explicit.filter(id => active.some(member => member.id === id)))];
  if (selected.length) return selected;
  const mentioned = mentionedMembers(text, active);
  if (mentioned.length) return mentioned;
  const author = group.messages.find(message => message.id === replyTo)?.memberId;
  if (author && active.some(member => member.id === author)) return [author];
  return [group.coordinatorId];
}
export const workLabels: Record<string, string> = { queued: "待执行", dispatching: "正在启动", running: "执行中", waiting_children: "等待成员结果", completed: "已完成", failed: "执行失败", stopping: "正在停止", cancelled: "已停止", uncertain: "需要检查" };
export function groupStatus(group: Group): string {
  if (group.archived) return "已归档";
  if (group.works.some(work => work.status === "uncertain")) return "需要检查";
  if (group.paused) return "已暂停";
  const active = group.works.filter(work => ["running", "dispatching", "stopping"].includes(work.status)).length;
  if (active) return `${active} 人工作中`;
  if (group.works.some(work => !terminalWork(work.status))) return "等待协作";
  const lastMessage = group.messages[group.messages.length - 1];
  const lastRequest = [...group.messages].reverse().find(message => message.kind === "user")?.id ?? group.works.find(work => work.id === lastMessage?.workId)?.rootId;
  if (group.works.some(work => work.status === "failed" && work.rootId === lastRequest)) return "执行失败";
  return "当前空闲";
}

export interface TeamTemplate { coordinatorName?: string | null; coordinatorRole?: string | null; defaultModelId?: string | null; id: string; name: string; description: string; source: string; members: { name: string; role: string; modelId?: string }[] }
export const groupTemplates = () => invoke<TeamTemplate[]>("group_team_templates");
export const groupSaveTeam = (groupId: string, name: string) => invoke<TeamTemplate>("group_team_save", { groupId, name });
export const groupDeleteTeam = (templateId: string) => invoke<void>("group_team_delete", { templateId });
export const groupMemberChange = (groupId: string, action: "add" | "remove" | "refresh", memberId?: string, expert?: string) => invoke<void>("group_member_change", { groupId, action, memberId: memberId ?? null, expert: expert ?? null });
export const groupDecision = (groupId: string, text: string, messageId: string, decisionId?: string) => invoke<void>("group_decision", { groupId, text, messageId, decisionId: decisionId ?? null });
