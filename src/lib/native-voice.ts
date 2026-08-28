import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface NativeVoiceEvent {
  kind: "interim" | "final" | "error";
  text?: string;
  message?: string;
  hint?: string;
}

export async function nativeVoiceAvailable(): Promise<boolean> {
  return invoke<boolean>("voice_native_available");
}

export async function startNativeVoice(language = "zh-CN"): Promise<void> {
  await invoke<void>("voice_native_start", { language });
}

export async function stopNativeVoice(): Promise<void> {
  await invoke<void>("voice_native_stop");
}

export async function subscribeNativeVoice(
  handler: (event: NativeVoiceEvent) => void,
): Promise<UnlistenFn> {
  return listen<NativeVoiceEvent>("agent://voice", (event) => handler(event.payload));
}
