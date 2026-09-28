import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectsSave } from "@/lib/agent-client";
import { useProjectsStore, type ProjectMeta } from "../projects-store";
import type { SessionSummary } from "@/lib/types";

vi.mock("@/lib/agent-client", () => ({
  projectsLoad: vi.fn().mockResolvedValue([]),
  projectsSave: vi.fn().mockResolvedValue(undefined),
}));

const project: ProjectMeta = {
  id: "p1", name: "交付", cwd: "/project", createdAt: "2026-09-01T00:00:00Z",
  connectors: [], experts: [], skills: [], plans: [], tasks: [], assets: [], members: [], conversations: [],
};
const session: SessionSummary = {
  sessionId: "s1", title: "探索方案", cwd: "/original", currentModelId: "m1", archived: false,
};

describe("project session movement", () => {
  beforeEach(() => {
    vi.mocked(projectsSave).mockReset().mockResolvedValue(undefined);
    useProjectsStore.setState({ projects: [structuredClone(project)], persisting: false, persistError: null });
  });

  it("移动只改变项目引用，重复移动受保护，移出不删除主会话", async () => {
    await useProjectsStore.getState().moveSessionToProject("p1", session);
    expect(useProjectsStore.getState().projects[0].conversations).toMatchObject([
      { sessionId: "s1", title: "探索方案", modelId: "m1", pendingProjectContext: true },
    ]);
    await expect(useProjectsStore.getState().moveSessionToProject("p1", session)).rejects.toThrow("已归属项目");
    useProjectsStore.getState().setProjectContextPending("p1", "s1", false);
    expect(useProjectsStore.getState().projects[0].conversations[0].pendingProjectContext).toBe(false);
    await useProjectsStore.getState().detachSessionFromProject("p1", "s1");
    expect(useProjectsStore.getState().projects[0].conversations).toEqual([]);
    expect(session).toMatchObject({ sessionId: "s1", cwd: "/original" });
  });

  it("落盘失败时回滚移入，保留原归属", async () => {
    vi.mocked(projectsSave).mockRejectedValueOnce(new Error("disk full"));
    await expect(useProjectsStore.getState().moveSessionToProject("p1", session)).rejects.toThrow("disk full");
    expect(useProjectsStore.getState().projects[0].conversations).toEqual([]);
  });
});
