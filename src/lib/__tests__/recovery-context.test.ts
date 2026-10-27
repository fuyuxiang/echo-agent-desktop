import { beforeEach, expect, it, vi } from "vitest";

beforeEach(() => { localStorage.clear(); vi.resetModules(); });

it("retains only the selected task identity across a new document and clears it on home/deletion", async () => {
  const { useSessionsStore } = await import("@/stores/sessions-store");
  const context = await import("../recovery-context");
  useSessionsStore.getState().upsert({ sessionId: "task-1", cwd: "/work" });
  useSessionsStore.getState().setCurrent("task-1");
  vi.resetModules();
  const fresh = (await import("@/stores/sessions-store")).useSessionsStore;
  expect(fresh.getState().currentSessionId).toBeNull();
  expect((await import("../recovery-context")).readRecoverySessionId()).toBe("task-1");
  useSessionsStore.getState().setCurrent(null);
  expect(context.readRecoverySessionId()).toBeNull();
  useSessionsStore.getState().setCurrent("task-1");
  useSessionsStore.getState().remove("task-1");
  expect(context.readRecoverySessionId()).toBeNull();
});

it("preserves corrupt checkpoint bytes instead of overwriting them", async () => {
  const { RECOVERY_SESSION_KEY, readRecoverySessionId, saveRecoverySessionId } = await import("../recovery-context");
  localStorage.setItem(RECOVERY_SESSION_KEY, "{broken");
  expect(readRecoverySessionId()).toBeNull();
  saveRecoverySessionId("new-task");
  expect(localStorage.getItem(RECOVERY_SESSION_KEY)).toBe("{broken");
});
