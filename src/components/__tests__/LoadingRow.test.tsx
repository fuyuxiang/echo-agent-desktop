import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoadingRow } from "../LoadingRow";

describe("LoadingRow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    vi.spyOn(Math, "random").mockReturnValue(0.6);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("按真实等待时长展示阶段，趣味提示不会覆盖状态或后台运行提醒", () => {
    const { container } = render(<LoadingRow startedAt={1_000} />);
    expect(screen.getByText("正在请求模型")).toBeInTheDocument();
    expect(screen.queryByText("可切换会话，任务会继续运行")).toBeNull();
    act(() => vi.advanceTimersByTime(2_000));
    expect(screen.getByText("正在等待模型响应")).toBeInTheDocument();
    expect(container.querySelector(".msg__loading-tip")).toBeNull();

    act(() => vi.advanceTimersByTime(1_000));
    const tip = container.querySelector(".msg__loading-tip")!;
    expect(tip.textContent).not.toBe("");
    expect(tip).toHaveAttribute("aria-live", "off");
    expect(screen.getByRole("status")).toHaveTextContent("正在等待模型响应");
    expect(screen.getByRole("status")).not.toHaveTextContent(tip.textContent!);

    act(() => vi.advanceTimersByTime(5_000));
    expect(screen.getByText("8秒")).toBeInTheDocument();
    expect(screen.getByText("可切换会话，任务会继续运行")).toBeInTheDocument();
    expect(tip).toBeInTheDocument();
  });

  it("等待满 3 秒才出现，此后每 12 秒切换且不连续重复，重渲染不会重置节奏", () => {
    const view = render(<LoadingRow startedAt={1_000} />);
    const tip = () => view.container.querySelector(".msg__loading-tip")?.textContent;
    act(() => vi.advanceTimersByTime(2_999));
    expect(tip()).toBeUndefined();
    act(() => vi.advanceTimersByTime(1));
    const first = tip();
    expect(first).toBeTruthy();
    view.rerender(<LoadingRow startedAt={1_000} />);
    act(() => vi.advanceTimersByTime(11_999));
    expect(tip()).toBe(first);
    act(() => vi.advanceTimersByTime(1));
    expect(tip()).toBeTruthy();
    expect(tip()).not.toBe(first);
  });

  it("页面隐藏时暂停轮换，返回后至多切换一条并重新等待 12 秒", () => {
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    const { container } = render(<LoadingRow />);
    act(() => vi.advanceTimersByTime(3_000));
    const first = container.querySelector(".msg__loading-tip")!.textContent;
    visibility = "hidden";
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      vi.advanceTimersByTime(60_000);
    });
    expect(container.querySelector(".msg__loading-tip")).toHaveTextContent(first!);
    expect(Math.random).toHaveBeenCalledTimes(1);
    visibility = "visible";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(Math.random).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".msg__loading-tip")!.textContent).not.toBe(first);
    act(() => vi.advanceTimersByTime(11_999));
    expect(Math.random).toHaveBeenCalledTimes(2);
    act(() => vi.advanceTimersByTime(1));
    expect(Math.random).toHaveBeenCalledTimes(3);
  });

  it.each([0, 15_000])("卸载后清理计时器和页面监听（已等待 %i 毫秒）", elapsed => {
    const view = render(<LoadingRow />);
    act(() => vi.advanceTimersByTime(elapsed));
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    const selections = vi.mocked(Math.random).mock.calls.length;
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      vi.advanceTimersByTime(60_000);
    });
    expect(Math.random).toHaveBeenCalledTimes(selections);
  });
});
