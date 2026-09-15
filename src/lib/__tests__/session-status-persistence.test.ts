import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import {
  onSessionStatusPersistenceIssue,
  persistSessionStatus,
  resetSessionStatusPersistenceForTests,
  retryPendingSessionStatuses,
} from "../session-status-persistence";

describe("session status persistence", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.useFakeTimers();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    resetSessionStatusPersistenceForTests();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {},
      configurable: true,
    });
  });
  afterEach(() => {
    resetSessionStatusPersistenceForTests();
    warnSpy.mockRestore();
    vi.useRealTimers();
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("sends the lifecycle state and monotonic observation time to native storage", () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    persistSessionStatus("session-1", "awaiting_answer", "2026-09-14T08:00:00.001Z");

    expect(invoke).toHaveBeenCalledWith("agent_set_session_status", {
      sessionId: "session-1",
      status: "awaiting_answer",
      updatedAt: "2026-09-14T08:00:00.001Z",
    });
  });

  it("automatically retries transient failures and surfaces exhaustion", async () => {
    const listener = vi.fn();
    onSessionStatusPersistenceIssue(listener);
    vi.mocked(invoke).mockRejectedValue(new Error("disk busy"));

    persistSessionStatus("session-1", "failed", "2026-09-14T08:00:00.002Z");
    await vi.runAllTimersAsync();

    expect(invoke).toHaveBeenCalledTimes(3);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
      status: "failed",
      pendingCount: 1,
    }));
  });

  it("keeps only the newest transition while an older IPC write is in flight", async () => {
    let finishFirst!: () => void;
    vi.mocked(invoke)
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finishFirst = resolve; }))
      .mockResolvedValue(undefined);

    persistSessionStatus("session-1", "working", "2026-09-14T08:00:00.001Z");
    persistSessionStatus("session-1", "completed", "2026-09-14T08:00:00.002Z");
    finishFirst();
    await vi.runAllTimersAsync();

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenLastCalledWith("agent_set_session_status", {
      sessionId: "session-1",
      status: "completed",
      updatedAt: "2026-09-14T08:00:00.002Z",
    });
  });

  it("allows the user to retry an exhausted durable write", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("read only"));
    persistSessionStatus("session-1", "paused", "2026-09-14T08:00:00.003Z");
    await vi.runAllTimersAsync();
    expect(invoke).toHaveBeenCalledTimes(3);

    vi.mocked(invoke).mockResolvedValue(undefined);
    expect(retryPendingSessionStatuses()).toBe(1);
    await vi.runAllTimersAsync();
    expect(invoke).toHaveBeenCalledTimes(4);
  });
});
