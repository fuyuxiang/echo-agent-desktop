import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useToastQueue } from "../use-toast-queue";

describe("useToastQueue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("merges repeated informational notices without accumulating timers", () => {
    const { result } = renderHook(() => useToastQueue());
    act(() => result.current.enqueueToast("加载失败"));
    const id = result.current.toasts[0].id;
    act(() => result.current.enqueueToast("加载失败"));
    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0].id).toBe(id);
    expect(vi.getTimerCount()).toBe(1);
  });
  it("keeps undo actions for separate tasks even when their labels match", () => {
    const { result } = renderHook(() => useToastQueue());
    const first = vi.fn(), second = vi.fn();
    act(() => result.current.enqueueToast("已归档", [{ label: "撤销", onClick: first }]));
    act(() => result.current.enqueueToast("已归档", [{ label: "撤销", onClick: second }]));
    expect(result.current.toasts).toHaveLength(2);
    result.current.toasts[0].actions[0].onClick();
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
  });
  it("preserves message kinds and does not merge different meanings of identical text", () => {
    const { result } = renderHook(() => useToastQueue());
    act(() => result.current.enqueueToast("HTTP 403", [], undefined, "info"));
    act(() => result.current.enqueueToast("HTTP 403", [], undefined, "error"));
    expect(result.current.toasts.map(({ message, kind }) => ({ message, kind }))).toEqual([
      { message: "HTTP 403", kind: "info" }, { message: "HTTP 403", kind: "error" },
    ]);
    act(() => vi.advanceTimersByTime(4000));
    expect(result.current.toasts.map(toast => toast.kind)).toEqual(["error"]);
  });
  it("keeps identically worded progress for independent tasks until each operation finishes", () => {
    const { result } = renderHook(() => useToastQueue());
    let first: number | undefined;
    act(() => { first = result.current.enqueueToast("正在提取记忆", [], undefined, "info", "memory:one"); });
    act(() => { result.current.enqueueToast("正在提取记忆", [], undefined, "info", "memory:two"); });
    expect(result.current.toasts).toHaveLength(2);
    act(() => result.current.dismissToast(first!));
    expect(result.current.toasts.map(toast => toast.operationKey)).toEqual(["memory:two"]);
  });
  it("bounds a burst and clears every removed notice's timer", () => {
    const { result, unmount } = renderHook(() => useToastQueue());
    act(() => { for (const message of ["一", "二", "三", "四"]) result.current.enqueueToast(message); });
    expect(result.current.toasts.map(t => t.message)).toEqual(["二", "三", "四"]);
    expect(vi.getTimerCount()).toBe(3);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("pauses expiry while a notice is being read, then uses the remaining time", () => {
    const { result } = renderHook(() => useToastQueue());
    act(() => result.current.enqueueToast("文件已复制"));
    const id = result.current.toasts[0].id;
    act(() => vi.advanceTimersByTime(1000));
    act(() => result.current.pauseToast(id, true));
    act(() => vi.advanceTimersByTime(30_000));
    expect(result.current.toasts).toHaveLength(1);
    act(() => result.current.pauseToast(id, false));
    act(() => vi.advanceTimersByTime(2999));
    expect(result.current.toasts).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.toasts).toHaveLength(0);
  });
  it("leaves longer to act or read diagnostics, and cancels dismissed timers", () => {
    const { result } = renderHook(() => useToastQueue());
    act(() => result.current.enqueueToast("加载失败：Failed to fetch"));
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current.toasts).toHaveLength(1);
    act(() => result.current.dismissToast(result.current.toasts[0].id));
    expect(result.current.toasts).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
