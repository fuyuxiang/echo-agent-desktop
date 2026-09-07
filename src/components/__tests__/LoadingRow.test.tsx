import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoadingRow } from "../LoadingRow";

describe("LoadingRow", () => {
  afterEach(() => vi.useRealTimers());

  it("按真实等待时长展示阶段，并提示桌面后台运行", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    render(<LoadingRow startedAt={1_000} />);

    expect(screen.getByText("正在理解任务")).toBeInTheDocument();
    expect(screen.queryByText("可切换会话，任务会继续运行")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(screen.getByText("正在等待模型响应")).toBeInTheDocument();
    expect(document.querySelector(".msg__loading-tip")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(document.querySelector(".msg__loading-tip")).toHaveTextContent("✦");

    act(() => {
      vi.advanceTimersByTime(4_000);
    });
    expect(screen.getByText("8秒")).toBeInTheDocument();
    expect(screen.getByText("可切换会话，任务会继续运行")).toBeInTheDocument();
  });
});
