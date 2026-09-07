import { describe, expect, it } from "vitest";
import {
  isAgentOwnedActiveStatus,
  isWaitingForUser,
  terminalSessionStatus,
} from "../turn-status";

describe("terminalSessionStatus", () => {
  it("区分正常完成、用户停止和协议失败", () => {
    expect(terminalSessionStatus({ stopReason: "end_turn" })).toBe("completed");
    expect(terminalSessionStatus({ stopReason: "cancelled" })).toBe("stopped");
    expect(terminalSessionStatus({ stopReason: "refusal" })).toBe("failed");
    expect(terminalSessionStatus({ stopReason: "max_tokens" })).toBe("failed");
    expect(terminalSessionStatus({
      stopReason: "cancelled",
      cancelTrigger: "send_now",
    })).toBe("working");
  });

  it("使用 cancellationCategory 识别伪装成 cancelled 的失败", () => {
    expect(terminalSessionStatus({
      stopReason: "cancelled",
      cancellationCategory: "HookDenied",
    })).toBe("failed");
    expect(terminalSessionStatus({
      stopReason: "cancelled",
      cancellationCategory: "PermissionRejected",
    })).toBe("stopped");
  });
});

describe("active status families", () => {
  it("聚合所有等待用户交互的状态", () => {
    expect(isWaitingForUser("awaiting_permission")).toBe(true);
    expect(isWaitingForUser("awaiting_answer")).toBe(true);
    expect(isWaitingForUser("awaiting_approval")).toBe(true);
    expect(isWaitingForUser("pending")).toBe(false);
  });

  it("Agent 异常退出只影响它正在拥有的活跃任务", () => {
    expect(isAgentOwnedActiveStatus("working")).toBe(true);
    expect(isAgentOwnedActiveStatus("planning")).toBe(true);
    expect(isAgentOwnedActiveStatus("awaiting_answer")).toBe(true);
    expect(isAgentOwnedActiveStatus("pending")).toBe(false);
    expect(isAgentOwnedActiveStatus("completed")).toBe(false);
  });
});
