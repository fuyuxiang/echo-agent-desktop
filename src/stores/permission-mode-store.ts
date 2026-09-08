import { create } from "zustand";
import type { PermissionMode, PermissionModeStatus } from "@/lib/agent-client";

interface PermissionModeState {
  mode: PermissionMode;
  status: PermissionModeStatus | null;
  setMode: (mode: PermissionMode) => void;
  setStatus: (status: PermissionModeStatus) => void;
}

export const usePermissionModeStore = create<PermissionModeState>((set) => ({
  mode: "ask",
  status: null,
  setMode: (mode) => set({ mode }),
  setStatus: (status) => set({
    status,
    mode:
      (status.runtimeSyncState === "failed" || status.runtimeSyncState === "syncing") &&
      status.runtimeAppliedMode
        ? status.runtimeAppliedMode
        : status.permissionMode,
  }),
}));

function asPermissionMode(value: unknown): PermissionMode | null {
  return value === "ask" || value === "auto" || value === "always-approve" ? value : null;
}

export function permissionModeFromEvent(payload: unknown): PermissionMode | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as Record<string, unknown>;
  const mode = value.permission_mode ?? value.permissionMode ??
    (value.yolo_mode === true ? "always-approve" : value.auto_mode === true ? "auto" : undefined);
  return asPermissionMode(mode);
}

export function permissionModeStatusFromEvent(payload: unknown): PermissionModeStatus | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as Record<string, unknown>;
  const hasStatusEnvelope = [
    "configuredPermissionMode",
    "configured_permission_mode",
    "autoModeAvailable",
    "auto_mode_available",
    "runtimeSyncState",
    "runtime_sync_state",
  ].some((key) => key in value);
  if (!hasStatusEnvelope) return null;
  const permissionMode = permissionModeFromEvent(payload);
  if (!permissionMode) return null;
  const configuredPermissionMode =
    asPermissionMode(value.configuredPermissionMode ?? value.configured_permission_mode) ??
    permissionMode;
  const runtimeAppliedMode = asPermissionMode(
    value.runtimeAppliedMode ?? value.runtime_applied_mode,
  ) ?? undefined;
  const rawSyncState = value.runtimeSyncState ?? value.runtime_sync_state;
  const runtimeSyncState =
    rawSyncState === "offline" || rawSyncState === "syncing" ||
    rawSyncState === "synced" || rawSyncState === "failed"
      ? rawSyncState
      : "offline";
  return {
    permissionMode,
    configuredPermissionMode,
    autoModeAvailable: (value.autoModeAvailable ?? value.auto_mode_available) !== false,
    autoModeUnavailableReason:
      (value.autoModeUnavailableReason ?? value.auto_mode_unavailable_reason) as string | undefined,
    alwaysApproveAvailable:
      (value.alwaysApproveAvailable ?? value.always_approve_available) !== false,
    alwaysApproveUnavailableReason:
      (value.alwaysApproveUnavailableReason ??
        value.always_approve_unavailable_reason) as string | undefined,
    locked: (value.locked as boolean | undefined) ?? false,
    lockedReason: (value.lockedReason ?? value.locked_reason) as string | undefined,
    runtimeSyncState,
    runtimeAppliedMode,
    runtimeSyncError:
      (value.runtimeSyncError ?? value.runtime_sync_error) as string | undefined,
  };
}
