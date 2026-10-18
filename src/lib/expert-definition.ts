import { invoke } from "@tauri-apps/api/core";

/** Native YAML merge preserves advanced configuration and rejects unsafe resets. */
export function mergeExpertDefinition(originalRaw: string, generatedRaw: string): Promise<string> {
  return invoke<string>("agents_merge_definition", { originalRaw, generatedRaw });
}
