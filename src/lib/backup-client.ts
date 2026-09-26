import { invoke } from "@tauri-apps/api/core";

export const BACKUP_UI_KEYS = [
  "echoagent.projects", "echoagent.drafts.v1", "echoagent.outbox.v1",
  "echoagent.draft-attachments.v1", "echoagent.task-artifacts.v1",
  "echoagent.usage", "echoagent.quota", "echoagent.usage-snapshots.v1",
  "echoagent.theme", "echoagent.fontSize",
] as const;
export interface BackupPreview { token: string; createdAt: string; fileCount: number; totalBytes: number; uiKeys: string[] }
export function exportBackup(): Promise<string | null> {
  const uiState: Record<string, string> = {};
  for (const key of BACKUP_UI_KEYS) {
    const raw = localStorage.getItem(key);
    if (raw !== null) uiState[key] = raw;
  }
  return invoke("backup_export", { uiState });
}
export const inspectBackup = () => invoke<BackupPreview | null>("backup_inspect");
export const restoreBackup = (token: string) => invoke<void>("backup_restore", { token });
export const backupLastError = () => invoke<string | null>("backup_last_error");

/** Must run before importing stores: module initialization reads persisted drafts. */
export async function restoreUiBeforeBootstrap(): Promise<void> {
  if (!("__TAURI_INTERNALS__" in window)) return;
  const restored = await invoke<Record<string, string> | null>("backup_restored_ui");
  if (restored === null) return;
  const entries = Object.entries(restored);
  if (entries.some(([key, value]) => !BACKUP_UI_KEYS.includes(key as typeof BACKUP_UI_KEYS[number]) || typeof value !== "string")) {
    throw new Error("恢复的界面数据格式无效，已保留恢复文件");
  }
  const previous = new Map(entries.map(([key]) => [key, localStorage.getItem(key)]));
  try {
    for (const [key, value] of entries) localStorage.setItem(key, value);
    // Backend snapshot is authoritative after restoration, never push stale cache.
    localStorage.removeItem("echoagent.projects.pending-backend-sync");
    await invoke("backup_acknowledge_ui");
  } catch (error) {
    for (const [key, value] of previous) {
      try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* Retry retains the native restore file. */ }
    }
    throw error;
  }
}
