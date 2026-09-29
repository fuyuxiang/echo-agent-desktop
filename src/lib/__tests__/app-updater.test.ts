import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), unlisten: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, isTauri: () => true }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

import { appUpdateErrorStage, friendlyUpdateError, installAppUpdate } from "../app-updater";

describe("native update error contract", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.listen.mockResolvedValue(mocks.unlisten);
  });

  it("preserves the native error stage and message and releases the progress listener", async () => {
    const error = { stage: "check", message: "服务器版本已变更，请重新确认更新" };
    mocks.invoke.mockRejectedValue(error);
    await expect(installAppUpdate("0.3.12")).rejects.toEqual(error);
    expect(mocks.invoke).toHaveBeenCalledWith("app_update_install", { expectedVersion: "0.3.12" });
    expect(mocks.unlisten).toHaveBeenCalledOnce();
    expect(appUpdateErrorStage(error, "download")).toBe("check");
    expect(friendlyUpdateError(error)).toBe(error.message);
  });

  it("keeps legacy string errors readable and falls back for unknown stages", () => {
    expect(friendlyUpdateError("Error: 下载中断")).toBe("下载中断");
    expect(friendlyUpdateError(new Error("Command app_update_install not found"))).toBe("当前安装包不支持在线更新");
    expect(appUpdateErrorStage({ stage: "unknown" }, "download")).toBe("download");
  });
});
