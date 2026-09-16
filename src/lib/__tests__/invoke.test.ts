import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { invokeCmd, AppError } from "../invoke";

const invokeMock = vi.mocked(invoke);

beforeEach(() => {
  invokeMock.mockReset();
});

describe("invokeCmd - 基础契约", () => {
  it("正常返回原值", async () => {
    invokeMock.mockResolvedValueOnce({ ok: true });
    const result = await invokeCmd<{ ok: boolean }>("ping", { x: 1 });
    expect(result).toEqual({ ok: true });
    expect(invokeMock).toHaveBeenCalledWith("ping", { x: 1 });
  });

  it("传入 undefined args 时不传给 invoke", async () => {
    invokeMock.mockResolvedValueOnce(null);
    await invokeCmd("ping");
    expect(invokeMock).toHaveBeenCalledWith("ping", undefined);
  });
});

describe("invokeCmd - AppError 结构化解析", () => {
  it("抛错为 AppError 子类（含 code/kind/message）", async () => {
    const wireErr = JSON.stringify({
      code: 1003,
      kind: "validation",
      message: "sessionId 不能为空",
    });
    invokeMock.mockRejectedValueOnce(new Error(`Error: ${wireErr}`));
    await expect(invokeCmd("foo", { x: 1 })).rejects.toMatchObject({
      code: 1003,
      kind: "validation",
      message: "sessionId 不能为空",
    });
  });

  it("解析失败时退化为普通 Error", async () => {
    invokeMock.mockRejectedValueOnce(new Error("plain boom"));
    await expect(invokeCmd("foo")).rejects.toThrow("plain boom");
  });
});

describe("invokeCmd - 超时", () => {
  it("默认 30s 超时（长任务需显式覆盖）", async () => {
    vi.useFakeTimers();
    invokeMock.mockImplementation(
      () => new Promise(() => {}) as unknown as Promise<unknown>,
    );
    const p = invokeCmd("slow");
    vi.advanceTimersByTime(30_001);
    await expect(p).rejects.toThrow(/超时|timed out/i);
    vi.useRealTimers();
  });

  it("opts.timeout 可覆盖默认", async () => {
    vi.useFakeTimers();
    invokeMock.mockImplementation(
      () => new Promise(() => {}) as unknown as Promise<unknown>,
    );
    const p = invokeCmd("slow", undefined, { timeoutMs: 100 });
    vi.advanceTimersByTime(101);
    await expect(p).rejects.toThrow(/超时|timed out/i);
    vi.useRealTimers();
  });

  it("opts.timeoutMs=0 表示不超时", async () => {
    invokeMock.mockResolvedValueOnce("ok");
    const result = await invokeCmd("ping", undefined, { timeoutMs: 0 });
    expect(result).toBe("ok");
  });
});

describe("invokeCmd - AbortSignal 取消", () => {
  it("已 abort 的 signal 直接抛 AbortError", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(invokeCmd("foo", undefined, { signal: ctrl.signal })).rejects.toThrow(/abort/i);
  });

  it("调用过程中 abort 触发拒绝", async () => {
    const ctrl = new AbortController();
    invokeMock.mockImplementation(
      () => new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error("aborted-by-test")), 50);
      }) as unknown as Promise<unknown>,
    );
    const p = invokeCmd("slow", undefined, { signal: ctrl.signal });
    ctrl.abort();
    await expect(p).rejects.toThrow();
  });
});

describe("AppError 类", () => {
  it("instanceof Error 与 AppError", () => {
    const err = new AppError({ code: 2003, kind: "network", message: "x" });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe(2003);
    expect(err.kind).toBe("network");
    expect(err.message).toBe("x");
    expect(err.name).toBe("AppError");
  });

  it("toJSON 输出可序列化对象", () => {
    const err = new AppError({ code: 1003, kind: "validation", message: "y" });
    expect(JSON.parse(JSON.stringify(err))).toEqual({
      name: "AppError",
      code: 1003,
      kind: "validation",
      message: "y",
    });
  });
});
