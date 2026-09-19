import { invoke } from "@tauri-apps/api/core";
import { extOf } from "@/lib/drop-utils";

export type ArtifactAuthorizationResult = "authorized" | "cancelled" | "mismatch";

export function errorMessage(error: unknown): string {
  return String(error).replace(/^Error:\s*/, "");
}

export function isUnauthorizedPathError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes("拒绝访问未授权的路径")
    || message.includes("未经用户授权")
    || message.includes("unauthorized path")
    || message.includes("access to the path is not authorized");
}

/**
 * Ask the user to grant the exact artifact through the native file picker.
 * Renderer/transcript paths are never capabilities: after the picker returns,
 * path_stat proves that the requested path now resolves through native state.
 */
export async function authorizeArtifactFile(
  path: string,
  cwd?: string,
): Promise<ArtifactAuthorizationResult> {
  const extension = extOf(path).replace(/^\./, "");
  const selected = await invoke<string[]>("filesystem_pick_files", {
    title: `选择并授权预览：${basename(path)}`,
    extensions: extension ? [extension] : null,
    multiple: false,
    maxFiles: 1,
  });
  if (selected.length === 0) return "cancelled";

  try {
    await invoke("path_stat", { path, cwd: cwd ?? null });
    return "authorized";
  } catch (error) {
    if (isUnauthorizedPathError(error)) return "mismatch";
    throw error;
  }
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || path;
}
