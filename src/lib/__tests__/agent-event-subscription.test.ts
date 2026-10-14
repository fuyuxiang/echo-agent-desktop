import { beforeEach, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { subscribeAgentEvents } from "../agent-client";

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(invoke).mockResolvedValue({ permissions: [], questions: [], folderTrustRequests: [], planApprovals: [] });
});

it("注册中途失败时解除先前监听，重试不会重复分发事件", async () => {
  const unlisten = vi.fn();
  vi.mocked(listen).mockResolvedValueOnce(unlisten).mockRejectedValueOnce(new Error("event unavailable"));
  await expect(subscribeAgentEvents({ onUpdate: vi.fn(), onComplete: vi.fn() })).rejects.toThrow("event unavailable");
  expect(unlisten).toHaveBeenCalledTimes(1);
});

it("初始化快照失败保留成功注册的事件监听直到正常退出", async () => {
  const unlisten = vi.fn();
  vi.mocked(listen).mockResolvedValue(unlisten);
  vi.mocked(invoke).mockRejectedValue(new Error("snapshot unavailable"));
  const stop = await subscribeAgentEvents({ onComplete: vi.fn() });
  expect(unlisten).not.toHaveBeenCalled();
  stop();
  expect(unlisten).toHaveBeenCalledTimes(1);
});
