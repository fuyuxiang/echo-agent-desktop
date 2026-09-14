import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { persistSessionStatus } from "../session-status-persistence";

describe("session status persistence", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {},
      configurable: true,
    });
  });
  afterEach(() => {
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
});
