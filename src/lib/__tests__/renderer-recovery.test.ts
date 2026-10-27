import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { startRendererHealth, useRendererRecoveryStatus, type RendererRecoveryStatus } from "../renderer-recovery";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
const ready: RendererRecoveryStatus = { phase: "ready", attempt: 0, maxAttempts: 3, message: "", windowGeneration: 1 };
let stop: (() => void) | undefined;
const unlisten = vi.fn();
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(listen).mockResolvedValue(unlisten);
  vi.mocked(invoke).mockResolvedValue(ready);
});
afterEach(() => { stop?.(); stop = undefined; vi.useRealTimers(); });

it("acknowledges the new document and publishes recovery without initializing or replaying agent work", async () => {
  const restored = { ...ready, phase: "restored" as const, attempt: 1, message: "界面已恢复" };
  vi.mocked(invoke).mockImplementation(async (command) => command === "desktop_recovery_status" ? ready : restored);
  const hook = renderHook(useRendererRecoveryStatus);
  await act(async () => { stop = startRendererHealth(); await vi.advanceTimersByTimeAsync(0); });
  expect(hook.result.current).toEqual(restored);
  const heartbeat = vi.mocked(invoke).mock.calls.find(([command]) => command === "desktop_renderer_heartbeat")!;
  expect(heartbeat[1]).toMatchObject({ documentId: expect.any(String), windowGeneration: 1 });
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "desktop_renderer_heartbeat")[1][1]).toEqual(heartbeat[1]);
  expect(vi.mocked(invoke).mock.calls.every(([command]) => command.startsWith("desktop_"))).toBe(true);
  stop?.(); stop = undefined;
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(unlisten).toHaveBeenCalledTimes(1);
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "desktop_renderer_heartbeat")).toHaveLength(2);
});

it("reacquires the window generation after replacement instead of looping on a stale receipt", async () => {
  let epoch = 1;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "desktop_recovery_status") return { ...ready, windowGeneration: epoch };
    if ((args as { windowGeneration: number }).windowGeneration !== epoch) throw new Error("stale");
    return { ...ready, windowGeneration: epoch };
  });
  await act(async () => { stop = startRendererHealth(); await vi.advanceTimersByTimeAsync(0); });
  epoch = 2;
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(invoke).toHaveBeenLastCalledWith("desktop_renderer_heartbeat", expect.objectContaining({ windowGeneration: 2 }));
});

it("keeps browser previews free of native heartbeat traffic", () => {
  vi.mocked(isTauri).mockReturnValue(false);
  stop = startRendererHealth();
  expect(invoke).not.toHaveBeenCalled();
  expect(listen).not.toHaveBeenCalled();
});
