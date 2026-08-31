import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface AppUpdateInfo {
  version: string;
  notes?: string | null;
  publishedAt?: string | null;
  mandatory: boolean;
}

export interface AppUpdateCheck {
  currentVersion: string;
  checkedAt: string;
  update?: AppUpdateInfo | null;
}

export interface AppUpdateProgress {
  event: "started" | "progress" | "downloaded" | "installed";
  downloaded: number;
  total?: number | null;
}

export function appUpdaterAvailable(): boolean {
  return isTauri();
}

export async function checkAppUpdate(): Promise<AppUpdateCheck> {
  if (!appUpdaterAvailable()) {
    throw new Error("检查更新仅在 EchoAgent 桌面应用中可用");
  }
  return invoke<AppUpdateCheck>("app_update_check");
}

export async function installAppUpdate(
  expectedVersion: string,
  onProgress?: (progress: AppUpdateProgress) => void,
): Promise<void> {
  if (!appUpdaterAvailable()) {
    throw new Error("安装更新仅在 EchoAgent 桌面应用中可用");
  }

  const unlisten = await listen<AppUpdateProgress>("app-update-progress", (event) => {
    onProgress?.(event.payload);
  });
  try {
    await invoke<void>("app_update_install", { expectedVersion });
  } finally {
    unlisten();
  }
}

export function friendlyUpdateError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/^Error:\s*/i, "")
    .replace(/^Command app_update_(?:check|install) not found$/i, "当前安装包不支持在线更新");
}
