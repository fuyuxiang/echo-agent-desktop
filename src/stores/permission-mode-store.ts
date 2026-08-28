import { create } from "zustand";
import type { PermissionMode } from "@/lib/agent-client";

interface PermissionModeState {
  mode: PermissionMode;
  setMode: (mode: PermissionMode) => void;
}

export const usePermissionModeStore = create<PermissionModeState>((set) => ({
  mode: "ask",
  setMode: (mode) => set({ mode }),
}));

export function permissionModeFromEvent(payload: unknown): PermissionMode | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as Record<string, unknown>;
  const mode = value.permission_mode ?? value.permissionMode ??
    (value.yolo_mode === true ? "always-approve" : value.auto_mode === true ? "auto" : undefined);
  return mode === "ask" || mode === "auto" || mode === "always-approve" ? mode : null;
}
