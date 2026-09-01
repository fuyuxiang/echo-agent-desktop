import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ActivityTab, PlanTab, TaskTab } from "../project-tabs";
import { useProjectsStore, type ProjectMeta } from "@/stores/projects-store";

vi.mock("@/lib/agent-client", () => ({
  projectsSave: vi.fn().mockResolvedValue(undefined),
  openLocalPath: vi.fn(),
  projectAssetMakeDir: vi.fn(),
  projectAssetRemove: vi.fn(),
  projectAssetsImport: vi.fn(),
}));

const project: ProjectMeta = {
  id: "p1",
  name: "发布项目",
  cwd: "/workspace",
  createdAt: new Date().toISOString(),
  connectors: [], experts: [], skills: [], assets: [], members: [],
  conversations: [{ sessionId: "existing", title: "历史会话", createdAt: new Date().toISOString() }],
  plans: [{ id: "plan1", title: "完成发布检查", status: "pending" }],
  tasks: [{ id: "task1", title: "修复阻断问题", scope: "personal", source: "manual", status: "pending" }],
};

describe("项目计划/任务与 Agent 会话闭环", () => {
  beforeEach(() => useProjectsStore.setState({ projects: [structuredClone(project)] }));

  it("计划交给 Agent 后进入进行中并关联会话", async () => {
    const onRun = vi.fn().mockResolvedValue("session-plan");
    render(<PlanTab projectId="p1" onRun={onRun} />);
    fireEvent.click(screen.getByRole("button", { name: "交给 Agent" }));
    await waitFor(() => expect(onRun).toHaveBeenCalledWith(expect.stringContaining("完成发布检查")));
    await waitFor(() => expect(useProjectsStore.getState().projects[0].plans[0]).toMatchObject({
      status: "in_progress", sessionId: "session-plan",
    }));
  });

  it("任务支持 Agent 执行和人工状态流转", async () => {
    const onRun = vi.fn().mockResolvedValue("session-task");
    render(<TaskTab projectId="p1" onRun={onRun} />);
    fireEvent.click(screen.getByRole("button", { name: "交给 Agent" }));
    await waitFor(() => expect(useProjectsStore.getState().projects[0].tasks[0].sessionId).toBe("session-task"));
    fireEvent.change(screen.getByRole("combobox", { name: /调整任务状态/ }), { target: { value: "completed" } });
    expect(useProjectsStore.getState().projects[0].tasks[0].status).toBe("completed");
  });

  it("项目动态可直接打开真实历史会话", () => {
    const onOpenSession = vi.fn();
    render(<ActivityTab projectId="p1" onOpenSession={onOpenSession} />);
    fireEvent.click(screen.getByText("历史会话"));
    expect(onOpenSession).toHaveBeenCalledWith("existing", "/workspace");
  });
});
