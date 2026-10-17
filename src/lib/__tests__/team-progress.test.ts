import { describe, expect, it } from "vitest";
import { teamProgress, teamTasks } from "../team-progress";
import type { RuntimeTeamInfo } from "../agent-client";

const team: RuntimeTeamInfo = { teamId: "123", members: ["代码专家", "文档助手"], createdAt: 1, promptIds: ["turn"] };
describe("团队任务关联", () => {
  it("再次使用团队时只显示最新轮次，历史失败不会覆盖本轮状态", () => {
    const tasks = teamTasks({ ...team, promptIds: ["old", "new"] }, [
      { id: "old", parentPromptId: "old", subagentType: "代码专家", status: "failed", description: "旧任务" },
      { id: "new", parentPromptId: "new", subagentType: "代码专家", status: "running", description: "新任务" },
    ], []);
    expect(tasks.map((task) => task.id)).toEqual(["new"]);
    expect(teamProgress(team, tasks)).toBe("执行中");
  });
  it("只计入成员且属于本团队轮次的任务，生命周期覆盖旧工具状态", () => {
    const tasks = teamTasks(team, [
      { id: "child", parentPromptId: "turn", description: "写代码", subagentType: "代码专家", status: "completed" },
      { id: "other-turn", parentPromptId: "unrelated", description: "其他任务", subagentType: "代码专家", status: "running" },
      { id: "other-member", parentPromptId: "turn", description: "审计", subagentType: "审计员", status: "running" },
    ], [{ id: "tool", subagentId: "child", parentPromptId: "turn", name: "写代码", description: "写代码", subagentType: "代码专家", status: "in_progress", isSpawn: true }]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].status).toBe("completed");
    expect(teamProgress(team, tasks)).toBe("部分成员已完成");
    expect(teamProgress(team, [...tasks, { id: "doc", member: "文档助手", status: "completed", description: "文档" }])).toBe("任务已完成");
  });
});
