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
  expect([...section.matchAll(/"([^"]+)"/g)].map((match) => match[1])).toEqual([...BACKUP_UI_KEYS]);
});

it("replaces the full restored snapshot and clears drafts absent from the backup", async () => {
  localStorage.setItem("echoagent.outbox.v1", "stale queued message");
  localStorage.setItem("echoagent.drafts.v1", "stale draft");
  localStorage.setItem("organization-token", "retain");
  invoke.mockResolvedValueOnce({ "echoagent.theme": "dark" });
  await restoreUiBeforeBootstrap();
  expect(localStorage.getItem("echoagent.outbox.v1")).toBeNull();
  expect(localStorage.getItem("echoagent.drafts.v1")).toBeNull();
  expect(localStorage.getItem("organization-token")).toBe("retain");
});
it("rolls back keys removed from the snapshot when acknowledgement fails", async () => {
  localStorage.setItem("echoagent.outbox.v1", "queued message");
  localStorage.setItem("echoagent.projects.pending-backend-sync", "pending");
  invoke.mockResolvedValueOnce({ "echoagent.theme": "dark" }).mockRejectedValueOnce(new Error("ack failed"));
  await expect(restoreUiBeforeBootstrap()).rejects.toThrow("ack failed");
  expect(localStorage.getItem("echoagent.outbox.v1")).toBe("queued message");
  expect(localStorage.getItem("echoagent.projects.pending-backend-sync")).toBe("pending");
  expect(localStorage.getItem("echoagent.theme")).toBeNull();
});
