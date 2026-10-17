import type { RuntimeTeamInfo } from "./agent-client";
import type { SubagentRuntime } from "@/stores/subagent-store";
import type { SubagentActivity } from "./subagents";

export interface TeamTask {
  id: string;
  member?: string;
  promptId?: string;
  description: string;
  status: string;
}

export function teamTasks(team: RuntimeTeamInfo, live: SubagentRuntime[], transcript: SubagentActivity[]): TeamTask[] {
  const currentPrompt = team.promptIds?.[team.promptIds.length - 1];
  const tasks = new Map<string, TeamTask>();
  for (const task of transcript) {
    const id = task.subagentId ?? task.id;
    tasks.set(id, { id, member: task.subagentType, promptId: task.parentPromptId, description: task.description ?? task.name, status: task.status });
  }
  for (const task of live) {
    // Older task results can lack a child id. Match their turn and task title
    // before preferring the authoritative lifecycle record.
    for (const [id, previous] of tasks) {
      if (id !== task.id && task.parentPromptId && previous.promptId === task.parentPromptId && previous.member === task.subagentType && previous.description === task.description) tasks.delete(id);
    }
    tasks.set(task.id, { id: task.id, member: task.subagentType, promptId: task.parentPromptId, description: task.description, status: task.status });
  }
  return [...tasks.values()].filter((task) => task.member && team.members.includes(task.member)
    && (!currentPrompt || task.promptId === currentPrompt));
}

export function teamProgress(team: RuntimeTeamInfo, tasks: TeamTask[]): string {
  if (tasks.some((task) => ["running", "in_progress"].includes(task.status))) return "执行中";
  if (tasks.some((task) => ["failed", "cancelled"].includes(task.status))) return "有任务未完成";
  if (team.members.every((member) => tasks.some((task) => task.member === member && task.status === "completed"))) return "任务已完成";
  return tasks.length > 0 ? "部分成员已完成" : "待派发任务";
}
