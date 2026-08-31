import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  agentAuthStatus: vi.fn(),
  agentNewSession: vi.fn(),
  providersList: vi.fn(),
}));

vi.mock("../agent-client", () => mocks);

import { ensureSession } from "../ensure-session";
import { useSessionStore } from "@/stores/session-store";
import { useSessionsStore } from "@/stores/sessions-store";

describe("ensureSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSessionStore.getState().reset();
    useSessionsStore.setState({
      homeCwd: "/tmp/echoagent-test",
      currentSessionId: null,
      independent: [],
      workspaceSessions: {},
    });
    mocks.agentAuthStatus.mockResolvedValue({
      ready: true,
      providers: ["MiniMax-M3"],
    });
    mocks.providersList.mockResolvedValue({
      providers: [{ id: "custom" }],
      models: [{ modelId: "MiniMax-M3", providerId: "custom" }],
    });
    mocks.agentNewSession.mockResolvedValue("session-1");
  });

  it("内部入口创建会话时显式传入配置模型", async () => {
    await expect(ensureSession()).resolves.toBe("session-1");

    expect(mocks.agentNewSession).toHaveBeenCalledWith(
      "/tmp/echoagent-test",
      "MiniMax-M3",
    );
    expect(useSessionsStore.getState().independent[0]?.currentModelId).toBe(
      "MiniMax-M3",
    );
  });

  it("没有配置模型时不创建 Runtime 默认会话", async () => {
    mocks.providersList.mockResolvedValue({ providers: [], models: [] });

    await expect(ensureSession()).rejects.toThrow("设置 → 模型");
    expect(mocks.agentNewSession).not.toHaveBeenCalled();
  });
});
