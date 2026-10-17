import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
import { pluginsAction } from "../agent-client";

const ipc = vi.mocked(invoke);
describe("Runtime extension action outcomes", () => {
  beforeEach(() => vi.clearAllMocks());

  for (const [name, action] of [["plugins", pluginsAction]] as const) {
    it(`${name} preserves a real successful outcome`, async () => {
      const outcome = { status: "success", message: "Applied", requiresReload: false, requiresRestart: false };
      ipc.mockResolvedValueOnce(outcome);
      await expect(action("session-1", { type: "reload" })).resolves.toEqual(outcome);
      expect(ipc).toHaveBeenCalledWith("plugins_action", {
        sessionId: "session-1", action: { type: "reload" },
      });
    });

    for (const status of ["validation_error", "internal_error", "not_found", "unsupported", "confirmation_required"] as const) {
      it(`${name} rejects ${status} returned by a fulfilled native IPC`, async () => {
        ipc.mockResolvedValueOnce({ status, message: "配置已保存，但当前会话重载失败。请重试。", requiresReload: true, requiresRestart: false });
        await expect(action("session-1", { type: "reload" })).rejects.toThrow("配置已保存，但当前会话重载失败。请重试。");
      });
    }

    it(`${name} rejects a missing or malformed status rather than assuming success`, async () => {
      for (const value of [undefined, null, {}, { ok: true }, { status: "unexpected", message: "" }]) {
        ipc.mockResolvedValueOnce(value);
        await expect(action("session-1", { type: "reload" })).rejects.toThrow();
      }
    });
  }
});
