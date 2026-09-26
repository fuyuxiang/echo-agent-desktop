import { expect, it, vi } from "vitest";
vi.mock("@/lib/agent-client", () => ({ projectsLoad: vi.fn(), projectsSave: vi.fn() }));
import { migrateProjectWorkItems } from "../projects-store";
it("migrates both legacy lists without merging colliding ids or losing session/model state", () => {
  const tasks = migrateProjectWorkItems({
    tasks: [{ id: "same", title: "task", scope: "personal", source: "manual", status: "paused" }],
    plans: [{ id: "same", title: "plan", status: "in_progress", modelId: "m", sessionId: "s" }],
  });
  expect(tasks).toMatchObject([{ id: "same", title: "task" }, { id: "legacy-plan:same", title: "plan", sessionId: "s", modelId: "m", status: "in_progress" }]);
  expect(migrateProjectWorkItems({ tasks, plans: [] })).toEqual(tasks);
});
