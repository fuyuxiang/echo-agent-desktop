import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted, so the mock object must be created inside vi.hoisted.
const api = vi.hoisted(() => ({
  listTasks: vi.fn(),
  createTask: vi.fn(),
  getTask: vi.fn(),
  deleteTask: vi.fn(),
  renameTask: vi.fn(),
  getChangeSet: vi.fn(),
  listVerifications: vi.fn(),
  listProblems: vi.fn(),
  orchestratorState: vi.fn(),
}));

vi.mock("../lib/tauri-api", () => ({ codingApi: api }));

import { useTaskStore } from "../store/task-store";
import type { CodingTask, VerificationRecord } from "../lib/types";

function task(overrides: Partial<CodingTask> = {}): CodingTask {
  return {
    id: "t1",
    name: "重构登录",
    requirement: "改成 OIDC",
    phase: "implementing",
    acceptanceCriteria: [],
    taskNodes: [],
    planRequired: false,
    createdAt: "2026-09-11T00:00:00Z",
    updatedAt: "2026-09-11T00:00:00Z",
    ...overrides,
  };
}

function record(overrides: Partial<VerificationRecord> = {}): VerificationRecord {
  return {
    id: "v1",
    taskId: "t1",
    kind: "test",
    command: "pnpm test",
    status: "passed",
    exitCode: 0,
    stdout: "",
    stderr: "",
    durationMs: 10,
    startedAt: "2026-09-11T00:00:00Z",
    finishedAt: "2026-09-11T00:00:01Z",
    structured: true,
    ...overrides,
  };
}

describe("task store", () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
    useTaskStore.setState({ root: "" });
    useTaskStore.getState().reset();
    api.getChangeSet.mockResolvedValue({
      taskId: "t1",
      baselineFiles: [],
      changes: [],
      createdAt: "",
      reviewedFiles: [],
    });
    api.listVerifications.mockResolvedValue([]);
    api.listProblems.mockResolvedValue([]);
    api.orchestratorState.mockResolvedValue({
      task: task(),
      problems: [],
      repairRounds: [],
      changedFileCount: 0,
      maxRepairRounds: 3,
    });
  });

  it("does nothing without a workspace", async () => {
    await useTaskStore.getState().refreshSummaries();
    expect(api.listTasks).not.toHaveBeenCalled();
  });

  it("loads task summaries for the workspace", async () => {
    api.listTasks.mockResolvedValue([
      { id: "t1", name: "重构登录", phase: "implementing", updatedAt: "" },
    ]);
    useTaskStore.getState().setRoot("/repo");
    await useTaskStore.getState().refreshSummaries();
    expect(useTaskStore.getState().summaries).toHaveLength(1);
  });

  it("creates a task and refreshes the list", async () => {
    api.createTask.mockResolvedValue(task());
    api.listTasks.mockResolvedValue([{ id: "t1", name: "重构登录", phase: "idle", updatedAt: "" }]);
    useTaskStore.getState().setRoot("/repo");
    const created = await useTaskStore.getState().createTask("重构登录", "改成 OIDC");
    expect(created?.id).toBe("t1");
    expect(api.listTasks).toHaveBeenCalled();
  });

  it("surfaces a backend failure instead of throwing", async () => {
    api.listTasks.mockRejectedValue(new Error("读取任务列表失败"));
    useTaskStore.getState().setRoot("/repo");
    await useTaskStore.getState().refreshSummaries();
    expect(useTaskStore.getState().error).toBe("读取任务列表失败");
  });

  it("treats the orchestrator's task copy as authoritative", async () => {
    api.getTask.mockResolvedValue(task({ phase: "idle" }));
    api.orchestratorState.mockResolvedValue({
      task: task({ phase: "gating" }),
      problems: [],
      repairRounds: [],
      changedFileCount: 2,
      maxRepairRounds: 3,
    });
    useTaskStore.getState().setRoot("/repo");
    await useTaskStore.getState().selectTask("t1");
    // The phase must come from the orchestrator, not the plain task read.
    expect(useTaskStore.getState().task?.phase).toBe("gating");
    expect(useTaskStore.getState().orchestrator?.changedFileCount).toBe(2);
  });

  it("applies a phase event to both the task and its summary", () => {
    useTaskStore.setState({
      task: task(),
      summaries: [{ id: "t1", name: "重构登录", phase: "implementing", updatedAt: "" }],
    });
    useTaskStore.getState().applyPhase("t1", "blocked");
    expect(useTaskStore.getState().task?.phase).toBe("blocked");
    expect(useTaskStore.getState().summaries[0].phase).toBe("blocked");
  });

  it("ignores a phase event for a different task", () => {
    useTaskStore.setState({ task: task({ id: "t1", phase: "implementing" }) });
    useTaskStore.getState().applyPhase("other", "blocked");
    expect(useTaskStore.getState().task?.phase).toBe("implementing");
  });

  it("appends verification records only for the active task", () => {
    useTaskStore.setState({ task: task(), verifications: [] });
    useTaskStore.getState().applyVerification(record());
    expect(useTaskStore.getState().verifications).toHaveLength(1);
    useTaskStore.getState().applyVerification(record({ id: "v2", taskId: "other" }));
    expect(useTaskStore.getState().verifications).toHaveLength(1);
  });

  it("clears state when the workspace changes", () => {
    useTaskStore.setState({ root: "/repo", task: task(), verifications: [record()] });
    useTaskStore.getState().setRoot("/other");
    expect(useTaskStore.getState().task).toBeNull();
    expect(useTaskStore.getState().verifications).toHaveLength(0);
  });

  it("deleting the active task clears it", async () => {
    api.deleteTask.mockResolvedValue(undefined);
    api.listTasks.mockResolvedValue([]);
    useTaskStore.setState({ root: "/repo", task: task() });
    await useTaskStore.getState().deleteTask("t1");
    expect(useTaskStore.getState().task).toBeNull();
  });
});
