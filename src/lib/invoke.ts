/**
 * 统一 IPC invoke 入口。
 *
 * 取代调用方直接 `import { invoke } from "@tauri-apps/api/core"`，承担：
 * 1. 超时控制（默认 30s，可按命令覆盖，0 表示不超时）。
 * 2. AbortSignal 取消。
 * 3. 结构化 AppError 解析（识别 Rust 端 `src-tauri/src/error.rs::wire::WireEnvelope`）。
 *
 * 注意：262 处既有调用方暂不强制迁移，本模块作为「可选升级入口」存在；
 * 后续模块（capability 分组、WebDAV、Marketplace）将首先迁移到 invokeCmd。
 */

import { invoke as tauriInvoke } from "@tauri-apps/api/core";

export const DEFAULT_TIMEOUT_MS = 30_000;

export type ErrorKind =
  | "validation"
  | "state"
  | "network"
  | "filesystem"
  | "permission"
  | "credential"
  | "timeout"
  | "cancelled"
  | "verificationToken"
  | "internal";

export interface AppErrorPayload {
  code: number;
  kind: ErrorKind | string;
  message: string;
}

/** 类型化错误：Rust 端 `AppError` 在 IPC 抛出后被本类捕获。 */
export class AppError extends Error implements AppErrorPayload {
  public readonly code: number;
  public readonly kind: ErrorKind | string;
  public override readonly name: string = "AppError";

  constructor(payload: AppErrorPayload) {
    super(payload.message);
    this.code = payload.code;
    this.kind = payload.kind;
  }

  toJSON(): { name: string; code: number; kind: string; message: string } {
    return { name: this.name, code: this.code, kind: this.kind, message: this.message };
  }
}

export interface InvokeOptions {
  /** 超时（毫秒）。默认 30000；设为 0 表示永不超时。 */
  timeoutMs?: number;
  /** 取消信号。已 abort 时直接拒绝；调用过程中 abort 也会拒绝。 */
  signal?: AbortSignal;
  /** 自定义标签，便于日志与错误上报。 */
  label?: string;
}

const APP_ERROR_CODE_MIN = 1000;
const APP_ERROR_CODE_MAX = 9999;

/**
 * 解析 IPC 抛出的字符串，提取结构化 AppError。
 * 兼容 Rust Debug 形式 `Error { .. }` 与纯 JSON 字符串。
 */
function parseAppErrorFromMessage(raw: string): AppErrorPayload | null {
  // 1) 整串就是 JSON
  const direct = tryJsonObject(raw);
  if (direct && looksLikeAppError(direct)) return direct as AppErrorPayload;

  // 2) 字符串里嵌套 JSON 子串（常见于 "Error: {...}"）
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const nested = tryJsonObject(raw.slice(start, end + 1));
    if (nested && looksLikeAppError(nested)) return nested as AppErrorPayload;
  }

  // 3) Rust Debug 形式：code: NNN, message: "..."
  const codeMatch = raw.match(/code:\s*(-?\d+)/);
  const msgMatch = raw.match(/message:\s*"([^"]*)"/);
  if (codeMatch && msgMatch) {
    const code = parseInt(codeMatch[1], 10);
    const message = msgMatch[1];
    if (code >= APP_ERROR_CODE_MIN && code < APP_ERROR_CODE_MAX) {
      return { code, kind: "internal", message };
    }
  }
  return null;
}

function tryJsonObject(s: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(s);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
  } catch {
    /* not JSON */
  }
  return null;
}

function looksLikeAppError(obj: Record<string, unknown>): boolean {
  if (typeof obj.code !== "number") return false;
  if (typeof obj.message !== "string") return false;
  if (obj.code < APP_ERROR_CODE_MIN || obj.code > APP_ERROR_CODE_MAX) return false;
  // RPC Error 的 message 通常是固定枚举（"Internal error"/"Invalid params" 等），
  // 而 AppError 不会有这些 message 出现在错误体里。
  const msg = obj.message;
  if (/^(Internal error|Invalid params|Method not found|Unknown error|Parse error|Invalid Request)$/i.test(msg)) {
    return false;
  }
  return true;
}

/**
 * 统一 IPC 调用。
 * - 默认 30s 超时；timeoutMs=0 关闭超时；timeoutMs<0 抛错。
 * - 支持 AbortSignal。
 * - 错误自动解析为 AppError 实例；解析失败时按原 Error 抛出。
 */
export async function invokeCmd<T = unknown>(
  command: string,
  args?: Record<string, unknown>,
  opts: InvokeOptions = {},
): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal, label } = opts;

  if (timeoutMs < 0) {
    throw new Error(`invokeCmd: timeoutMs 不能为负（command=${command}, label=${label ?? ""}）`);
  }
  if (signal?.aborted) {
    throw makeAbortError();
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  let timeoutReject: ((reason: Error) => void) | null = null;

  const promise = tauriInvoke(command, args as Record<string, unknown> | undefined);

  // 包装 promise，使超时与取消都能 reject
  const guarded = new Promise<T>((resolve, reject) => {
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        const e = new Error(`IPC 调用超时：${command}（${timeoutMs}ms）`);
        e.name = "IpcTimeoutError";
        timeoutReject = reject;
        reject(e);
      }, timeoutMs);
    }

    const onAbort = () => {
      if (timer) clearTimeout(timer);
      reject(makeAbortError());
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    promise.then(
      (v) => {
        if (timer) clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve(v as T);
      },
      (err) => {
        if (timer) clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
        // 已经是超时触发的 reject，避免重复处理
        if (timeoutReject && err && (err as Error).name === "IpcTimeoutError") {
          reject(err);
          return;
        }
        reject(rewrapError(err, command));
      },
    );
  });

  return guarded;
}

function makeAbortError(): Error {
  const e = new Error("IPC 调用已取消（abort）");
  e.name = "AbortError";
  return e;
}

/**
 * 将 IPC 抛出的任何错误转为 Error/AppError：
 * - 字符串 / Error.message 内含结构化 AppError → 抛出 AppError
 * - 已经是 AppError → 直接抛
 * - 否则 → 包成 Error，message 保留
 */
function rewrapError(original: unknown, command: string): Error {
  if (original instanceof AppError) return original;

  // Error 实例：尝试解析 message
  if (original instanceof Error) {
    const parsed = parseAppErrorFromMessage(original.message);
    if (parsed) return new AppError(parsed);
    // 已经有 name/Message，原样抛
    return original;
  }

  // 字符串
  if (typeof original === "string") {
    const parsed = parseAppErrorFromMessage(original);
    if (parsed) return new AppError(parsed);
    return new Error(`IPC 调用 ${command} 失败：${original}`);
  }

  return new Error(`IPC 调用 ${command} 失败：${String(original)}`);
}
