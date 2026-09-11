import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getChangeSet: vi.fn(),
  captureBaseline: vi.fn(),
  syncFromGit: vi.fn(),
  reportImplementation: vi.fn(),
}));

vi.mock("../lib/tauri-api", () => ({ codingApi: api }));

import { useSessionStore } from "@/stores/session-store";

const refreshTaskState = vi.fn(async () => undefined);
const taskStoreState = { task: null as { id: string; phase: import("../lib/types").TaskPhase } | null };

vi.mock("../store/task-store", () => ({
  useTaskStore: Object.assign(
    (selector: (state: typeof taskStoreState) => unknown) => selector(taskStoreState),
    {
      getState: () => ({ refreshTaskState }),
    },
  ),
}));

import { useTaskLifecycle } from "../lib/task-lifecycle";

beforeEach(() => {
  for (const fn of Object.values(api)) {
    fn.mockReset();
    fn.mockResolvedValue(undefined);
  }
  refreshTaskState.mockClear();
  taskStoreState.task = null;
  useSessionStore.setState({ streaming: false });
});

describe("useTaskLifecycle", () => {
  it("does nothing without a workspace", async () => {
    renderHook(() => useTaskLifecycle(""));
    await waitFor(() => expect(api.getChangeSet).not.toHaveBeenCalled());
  });

  it("does nothing without a task", async () => {
    renderHook(() => useTaskLifecycle("/repo"));
    await waitFor(() => expect(api.getChangeSet).not.toHaveBeenCalled());
  });

  it("captures the baseline once when the task first enters Implementing", async () => {
    api.getChangeSet.mockResolvedValue({
      taskId: "t1",
      baselineFiles: [],
      changes: [
        {
          path: "src/a.ts",
          kind: "modified",
          added: 1,
          removed: 1,
          baselineContent: null,
          preExisting: false,
        },
      ],
      createdAt: "",
      reviewedFiles: [],
    });
    taskStoreState.task = { id: "t1", phase: "implementing" };
    renderHook(() => useTaskLifecycle("/repo"));
    await waitFor(() =>
      expect(api.captureBaseline).toHaveBeenCalledWith("/repo", "t1", ["src/a.ts"]),
    );
  });

  it("does not re-capture when the baseline is already populated", async () => {
    api.getChangeSet.mockResolvedValue({
      taskId: "t1",
      baselineFiles: ["src/a.ts"],
      changes: [],
      createdAt: "",
      reviewedFiles: [],
    });
    taskStoreState.task = { id: "t1", phase: "implementing" };
    renderHook(() => useTaskLifecycle("/repo"));
    await waitFor(() => expect(api.getChangeSet).toHaveBeenCalled());
    expect(api.captureBaseline).not.toHaveBeenCalled();
  });

  it("does not capture the baseline outside Implementing", async () => {
    taskStoreState.task = { id: "t1", phase: "verifying" };
    useSessionStore.setState({ streaming: false });
    renderHook(() => useTaskLifecycle("/repo"));
    // The hook never reaches the Git call outside Implementing, so neither
    // getChangeSet nor captureBaseline should fire.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.getChangeSet).not.toHaveBeenCalled();
    expect(api.captureBaseline).not.toHaveBeenCalled();
  });

  it("syncs and reports when streaming falls while Implementing", async () => {
    api.getChangeSet.mockResolvedValue({
      taskId: "t1",
      baselineFiles: ["src/a.ts"],
      changes: [],
      createdAt: "",
      reviewedFiles: [],
    });
    taskStoreState.task = { id: "t1", phase: "implementing" };
    // Initial render with streaming=false — nothing to fire yet.
    useSessionStore.setState({ streaming: false });
    renderHook(() => useTaskLifecycle("/repo"));

    // Simulate a streaming turn finishing.
    await act(async () => {
      useSessionStore.setState({ streaming: true });
    });
    await act(async () => {
      useSessionStore.setState({ streaming: false });
    });

    await waitFor(() => expect(api.syncFromGit).toHaveBeenCalledWith("/repo", "t1"));
    await waitFor(() =>
      expect(api.reportImplementation).toHaveBeenCalledWith("/repo", "t1"),
    );
    // Order matters: sync must happen before report.
    const syncOrder = api.syncFromGit.mock.invocationCallOrder[0] ?? 0;
    const reportOrder = api.reportImplementation.mock.invocationCallOrder[0] ?? 0;
    expect(syncOrder).toBeLessThan(reportOrder);
    expect(refreshTaskState).toHaveBeenCalled();
  });

  it("skips the sync when the task is not in Implementing", async () => {
    taskStoreState.task = { id: "t1", phase: "verifying" };
    useSessionStore.setState({ streaming: false });
    renderHook(() => useTaskLifecycle("/repo"));

    await act(async () => {
      useSessionStore.setState({ streaming: true });
    });
    await act(async () => {
      useSessionStore.setState({ streaming: false });
    });

    // Give the effect a chance to run.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.syncFromGit).not.toHaveBeenCalled();
    expect(api.reportImplementation).not.toHaveBeenCalled();
  });

  it("survives a sync failure without breaking the workbench", async () => {
    api.getChangeSet.mockResolvedValue({
      taskId: "t1",
      baselineFiles: ["src/a.ts"],
      changes: [],
      createdAt: "",
      reviewedFiles: [],
    });
    api.syncFromGit.mockRejectedValue(new Error("git failure"));
    taskStoreState.task = { id: "t1", phase: "implementing" };
    useSessionStore.setState({ streaming: false });
    renderHook(() => useTaskLifecycle("/repo"));

    await act(async () => {
      useSessionStore.setState({ streaming: true });
    });
    await act(async () => {
      useSessionStore.setState({ streaming: false });
    });

    await waitFor(() => expect(api.syncFromGit).toHaveBeenCalled());
    // The report still fires — the orchestrator already has the truth on disk
    // and the failure surface is in the orchestrator's own verdict.
    await waitFor(() =>
      expect(api.reportImplementation).toHaveBeenCalledWith("/repo", "t1"),
    );
  });
});