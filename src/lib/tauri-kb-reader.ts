/**
 * Tauri 目录读取适配器 —— 把 EchoAgent 的 `list_dir` + `read_text_file`
 * 命令适配为 local-kb-provider 的 DirectoryReader 接口。
 *
 * 仅运行时使用(依赖 @tauri-apps/api 的 invoke);非 Tauri 环境(如 vitest)会抛错,
 * 由调用方 try/catch 降级。保持与 lib 层解耦,核心逻辑可测。
 */
import { invoke } from "@tauri-apps/api/core";
import type { DirectoryReader } from "./local-kb-provider";

/** Tauri 是否可用(非 Tauri 环境返回 false)。 */
export function isTauriAvailable(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * 构造一个基于 Tauri 命令的 DirectoryReader。
 *  - listDir:调用 list_dir(返回 {name,path,kind,size,modifiedAt})。
 *  - readText:调用 read_text_file(返回文件字符串,上限 256KB)。
 *  - readBytes:调用 read_file_base64(若后端提供;返回 base64 字符串),解码为字节。
 *    用于 docx 等 OOXML 文档的 zip 解压。命令不存在时返回 null(自动降级:docx 不提取)。
 */
export function createTauriDirectoryReader(): DirectoryReader {
  return {
    async listDir(path) {
      const entries: Array<{ name: string; path: string; kind: string }> = await invoke(
        "list_dir",
        { path, cwd: null, maxEntries: 2000 },
      );
      return entries.map((e) => ({
        name: e.name,
        path: e.path,
        isDir: e.kind === "directory",
      }));
    },
    async readText(path) {
      try {
        return await invoke<string>("read_text_file", { path, cwd: null, maxBytes: 256 * 1024 });
      } catch {
        return null;
      }
    },
    async readBytes(path) {
      try {
        const base64 = await invoke<string>("read_file_base64", { path, maxBytes: 1024 * 1024 });
        return base64ToBytes(base64);
      } catch {
        // 命令不存在(docx 索引需要后端 read_file_base64 支持);降级为不提取 docx。
        return null;
      }
    },
  };
}

function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.replace(/^data:[^;]*;base64,/, "").replace(/\s/g, "");
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
