import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("@/lib/agent-client", () => ({
  tasksList: vi.fn(),
  taskKill: vi.fn().mockResolvedValue(undefined),
}));

import { tasksList } from "@/lib/agent-client";
import { TasksPanel } from "../TasksPanel";

beforeEach(() => {
  vi.mocked(tasksList).mockReset().mockResolvedValue([]);
});

describe("TasksPanel", () => {
  it("初次加载失败时保留明确错误和重试入口", async () => {
    vi.mocked(tasksList)
      .mockRejectedValueOnce(new Error("任务通道不可用"))
      .mockResolvedValueOnce([]);
    render(<TasksPanel />);

    expect(await screen.findByRole("alert")).toHaveTextContent("加载运行中任务失败：任务通道不可用");
    fireEvent.click(screen.getByRole("button", { name: "重试加载运行中任务" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("瞬时刷新失败不移除已知任务的终止入口", async () => {
    vi.mocked(tasksList)
      .mockResolvedValueOnce([{ id: "task-123456", description: "后台分析", status: "running" }])
      .mockRejectedValueOnce(new Error("暂时断开"));
    const { rerender } = render(<TasksPanel refreshSignal={0} />);
    expect(await screen.findByText("后台分析")).toBeInTheDocument();

    rerender(<TasksPanel refreshSignal={1} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("暂时断开");
    expect(screen.getByText("后台分析")).toBeInTheDocument();
    expect(screen.getByTitle("终止")).toBeEnabled();
  });
});
