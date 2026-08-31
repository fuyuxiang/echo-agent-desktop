import { beforeEach, describe, expect, it, vi } from "vitest";

const { checkAppUpdate, installAppUpdate } = vi.hoisted(() => ({
  checkAppUpdate: vi.fn(),
  installAppUpdate: vi.fn(),
}));

vi.mock("@/lib/app-updater", () => ({
  checkAppUpdate,
  installAppUpdate,
  friendlyUpdateError: (error: unknown) => error instanceof Error ? error.message : String(error),
}));

import { useUpdateStore } from "../update-store";

describe("update-store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUpdateStore.setState({
      status: "idle",
      currentVersion: undefined,
      update: undefined,
      checkedAt: undefined,
      downloaded: 0,
      total: undefined,
      error: undefined,
    });
  });

  it("按后端 SemVer 结果记录可用更新", async () => {
    checkAppUpdate.mockResolvedValue({
      currentVersion: "0.3.8",
      checkedAt: "2026-08-31T08:00:00Z",
      update: { version: "0.3.9", notes: "fixes", mandatory: false },
    });

    await useUpdateStore.getState().check(true);

    expect(useUpdateStore.getState()).toMatchObject({
      status: "available",
      currentVersion: "0.3.8",
      update: { version: "0.3.9" },
    });
  });

  it("启动检查断网时不会进入可见错误状态", async () => {
    checkAppUpdate.mockRejectedValue(new Error("VPN unavailable"));

    await useUpdateStore.getState().check(false);

    expect(useUpdateStore.getState().status).toBe("idle");
    expect(useUpdateStore.getState().error).toBe("VPN unavailable");
  });

  it("安装时更新下载进度", async () => {
    useUpdateStore.setState({
      status: "available",
      update: { version: "0.3.9", mandatory: false },
    });
    installAppUpdate.mockImplementation(async (_version, onProgress) => {
      onProgress({ event: "progress", downloaded: 50, total: 100 });
      onProgress({ event: "downloaded", downloaded: 100, total: 100 });
      throw new Error("restart prevented in test");
    });

    await useUpdateStore.getState().install();

    expect(installAppUpdate).toHaveBeenCalledWith("0.3.9", expect.any(Function));
    expect(useUpdateStore.getState()).toMatchObject({
      status: "error",
      downloaded: 100,
      total: 100,
      error: "restart prevented in test",
    });
  });
});
