import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  commandsList,
  memoryDelete,
  memoryFlush,
  memoryRewrite,
  memorySave,
} from "../agent-client";

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

describe("memory command contract", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it("落盘和重写携带 Runtime 必需参数", async () => {
    invokeMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce("rewritten");
    await memoryFlush("session-1");
    await expect(memoryRewrite("session-1", "raw", "global memory")).resolves.toBe("rewritten");

    expect(invokeMock).toHaveBeenNthCalledWith(1, "memory_flush", { sessionId: "session-1" });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "memory_rewrite", {
      sessionId: "session-1",
      rawText: "raw",
      contextSummary: "global memory",
    });
  });

  it("写入和删除传递期望修订号", async () => {
    await memorySave("global", "MEMORY.md", "body", "/repo", "revision-1");
    await memoryDelete("global", "MEMORY.md", "/repo", "revision-2");

    expect(invokeMock).toHaveBeenNthCalledWith(1, "memory_save", {
      scope: "global",
      path: "MEMORY.md",
      content: "body",
      cwd: "/repo",
      expectedRevision: "revision-1",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "memory_delete", {
      scope: "global",
      path: "MEMORY.md",
      cwd: "/repo",
      expectedRevision: "revision-2",
    });
  });
});
