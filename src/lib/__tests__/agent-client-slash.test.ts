import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { commandsList } from "../agent-client";

const invokeMock = vi.mocked(invoke);

describe("commandsList", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue([]);
  });

  it("把会话和工作目录上下文传给 Tauri 后端", async () => {
    await commandsList("session-1", "/repo");

    expect(invokeMock).toHaveBeenCalledWith("commands_list", {
      sessionId: "session-1",
      cwd: "/repo",
    });
  });

  it("无上下文时显式传 null，保持 Tauri 参数稳定", async () => {
    await commandsList();

    expect(invokeMock).toHaveBeenCalledWith("commands_list", {
      sessionId: null,
      cwd: null,
    });
  });
});
