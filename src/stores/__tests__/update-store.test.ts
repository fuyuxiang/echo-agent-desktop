import { beforeEach, describe, expect, it, vi } from "vitest";

const { checkAppUpdate, installAppUpdate } = vi.hoisted(() => ({
  checkAppUpdate: vi.fn(),
  installAppUpdate: vi.fn(),
}));

vi.mock("@/lib/app-updater", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/app-updater")>(),
  checkAppUpdate,
  installAppUpdate,
}));

import { useUpdateStore } from "../update-store";

describe("update-store", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    useUpdateStore.setState({
      status: "idle",
      currentVersion: undefined,
      update: undefined,
      checkedAt: undefined,
      downloaded: 0,
      total: undefined,
      error: undefined,
      errorStage: undefined,
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

  it("手动检查失败记录检查阶段", async () => {
    checkAppUpdate.mockRejectedValue(new Error("检查超时"));
    await useUpdateStore.getState().check(true);
    expect(useUpdateStore.getState()).toMatchObject({ status: "error", errorStage: "check" });
  });

  it("下载阶段失败与安装阶段失败分开记录", async () => {
    useUpdateStore.setState({ status: "available", update: { version: "0.3.9", mandatory: false } });
    installAppUpdate.mockImplementationOnce(async (_version, onProgress) => {
      onProgress({ event: "started", downloaded: 0 });
      throw new Error("下载中断");
    });
    await useUpdateStore.getState().install();
    expect(useUpdateStore.getState()).toMatchObject({ status: "error", errorStage: "download" });
  });

  it.each(["安装前检查更新失败：连接超时", "更新已撤回或当前版本已经是最新版", "服务器版本已变更，请重新确认更新"])(
    "安装前检查失败仍显示检查阶段：%s", async (message) => {
      useUpdateStore.setState({ status: "available", update: { version: "0.3.9", mandatory: false } });
      installAppUpdate.mockRejectedValueOnce({ stage: "check", message });
      await useUpdateStore.getState().install();
      expect(useUpdateStore.getState()).toMatchObject({ status: "error", errorStage: "check", error: message });
    },
  );

  it.each(["download", "install"])("进度事件未到达时使用后端的 %s 错误阶段", async (stage) => {
    useUpdateStore.setState({ status: "available", update: { version: "0.3.9", mandatory: false } });
    installAppUpdate.mockRejectedValueOnce({ stage, message: "操作失败" });
    await useUpdateStore.getState().install();
    expect(useUpdateStore.getState()).toMatchObject({ status: "error", errorStage: stage, error: "操作失败" });
  });

  it("安装前检查期间保持忙碌状态，并阻止重复安装或重置", async () => {
    useUpdateStore.setState({ status: "available", update: { version: "0.3.9", mandatory: false } });
    let rejectInstall!: (error: unknown) => void;
    installAppUpdate.mockImplementationOnce(() => new Promise((_, reject) => { rejectInstall = reject; }));
    const pending = useUpdateStore.getState().install();
    expect(useUpdateStore.getState().status).toBe("checking");
    useUpdateStore.getState().resetResult();
    expect(useUpdateStore.getState().status).toBe("checking");
    const duplicate = useUpdateStore.getState().install();
    const check = useUpdateStore.getState().check(true);
    expect(installAppUpdate).toHaveBeenCalledTimes(1);
    expect(checkAppUpdate).not.toHaveBeenCalled();
    rejectInstall(new Error("安装前检查更新失败：连接超时"));
    await Promise.all([pending, duplicate, check]);
    expect(useUpdateStore.getState().errorStage).toBe("check");
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
      errorStage: "install",
    });
  });
});
