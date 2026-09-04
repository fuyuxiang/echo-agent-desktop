import { describe, expect, it, vi } from "vitest";
import { applySessionScopedFailure } from "../session-scoped-failure";

describe("applySessionScopedFailure", () => {
  it("会标记原会话失败，但不污染切换后的当前会话", () => {
    const setStatus = vi.fn();
    const setCurrentError = vi.fn();
    applySessionScopedFailure({
      failedSessionId: "project-session",
      currentSessionId: "other-session",
      message: "发送失败",
      setStatus,
      setCurrentError,
    });

    expect(setStatus).toHaveBeenCalledWith("project-session", "failed");
    expect(setCurrentError).not.toHaveBeenCalled();
  });

  it("仅当失败会话仍处于焦点时显示会话错误", () => {
    const setStatus = vi.fn();
    const setCurrentError = vi.fn();
    applySessionScopedFailure({
      failedSessionId: "project-session",
      currentSessionId: "project-session",
      message: "发送失败",
      setStatus,
      setCurrentError,
    });

    expect(setStatus).toHaveBeenCalledWith("project-session", "failed");
    expect(setCurrentError).toHaveBeenCalledWith("发送失败");
  });
});
