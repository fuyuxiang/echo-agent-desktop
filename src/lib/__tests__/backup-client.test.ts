import { beforeEach, afterEach, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { exportBackup, restoreUiBeforeBootstrap, BACKUP_UI_KEYS } from "../backup-client";
beforeEach(() => { localStorage.clear(); invoke.mockReset(); Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true }); });
afterEach(() => { Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); vi.restoreAllMocks(); });
it("exports only the reviewed UI allowlist", async () => {
  localStorage.setItem("echoagent.drafts.v1", "draft");
  localStorage.setItem("organization-token", "secret");
  await exportBackup();
  expect(invoke).toHaveBeenCalledWith("backup_export", { uiState: { "echoagent.drafts.v1": "draft" } });
});
it("restores before stores hydrate and acknowledges only after success", async () => {
  invoke.mockResolvedValueOnce({ "echoagent.drafts.v1": "new" });
  await restoreUiBeforeBootstrap();
  expect(localStorage.getItem("echoagent.drafts.v1")).toBe("new");
  expect(invoke).toHaveBeenLastCalledWith("backup_acknowledge_ui");
});
it("keeps the native recovery file when storage is full", async () => {
  invoke.mockResolvedValueOnce({ "echoagent.drafts.v1": "new" });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("full"); });
  await expect(restoreUiBeforeBootstrap()).rejects.toThrow("full");
  expect(invoke).not.toHaveBeenCalledWith("backup_acknowledge_ui");
});
it("Rust and renderer serialize the same backup UI allowlist", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync("src-tauri/src/backup.rs", "utf8");
  const section = source.slice(source.indexOf("pub const UI_KEYS"), source.indexOf("#[derive", source.indexOf("pub const UI_KEYS")));
  expect([...section.matchAll(/"(echoagent\.[^"]+)"/g)].map((match) => match[1])).toEqual([...BACKUP_UI_KEYS]);
});
