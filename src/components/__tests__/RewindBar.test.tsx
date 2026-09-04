import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { RewindBar } from "../RewindBar";

// The toolbar talks to EchoAgent over Tauri `invoke`, which doesn't exist under
// vitest — stub the three client calls it uses.
vi.mock("@/lib/agent-client", () => ({
  rewindPoints: vi.fn().mockResolvedValue([
    { promptIndex: 0, promptPreview: "first prompt", timestamp: "2026-01-01T00:00:00Z" },
  ]),
  rewindExecute: vi.fn().mockResolvedValue(undefined),
  sessionFork: vi.fn().mockResolvedValue("forked-session-id-1234"),
}));

// Re-import the mocked module so we can assert call args on the stubs.
const { rewindExecute, rewindPoints, sessionFork } = await import("@/lib/agent-client");

describe("RewindBar wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(rewindPoints).mockReset().mockResolvedValue([
      { promptIndex: 0, promptPreview: "first prompt", timestamp: "2026-01-01T00:00:00Z" },
    ]);
  });

  it("分叉成功后调用 onForked(新id) 与 onToast", async () => {
    const onForked = vi.fn();
    const onToast = vi.fn();
    render(
      <RewindBar sessionId="s1" onForked={onForked} onToast={onToast} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /分叉/ }));
    fireEvent.click(screen.getByRole("button", { name: "创建分叉" }));
    await waitFor(() => expect(onForked).toHaveBeenCalledWith(
      "forked-session-id-1234",
      "s1",
      undefined,
    ));
    expect(onToast).toHaveBeenCalled();
  });

  it("回溯成功后调用 onRewound 与 onToast", async () => {
    const onRewound = vi.fn();
    const onToast = vi.fn();
    render(
      <RewindBar sessionId="s1" onRewound={onRewound} onToast={onToast} />,
    );
    // 打开下拉触发加载回溯点。
    fireEvent.click(screen.getByRole("button", { name: /回溯/ }));
    // 选"仅对话"模式(模式下拉与时间线动作按钮共名片段,先精确选中模式)。
    const modeBtn = await screen.findByRole("button", { name: "仅对话" });
    fireEvent.click(modeBtn);
    // 时间线动作按钮的可访问名是"回溯到此处（仅对话)",点击它真正触发回溯。
    const actionBtn = await screen.findByRole("button", {
      name: /回溯到此处.*仅对话/,
    });
    fireEvent.click(actionBtn);
    await waitFor(() => expect(onRewound).toHaveBeenCalledWith("s1"));
    expect(rewindExecute).toHaveBeenCalledWith("s1", 0, "conversation", true);
    expect(onToast).toHaveBeenCalled();
  });

  it("切换会话后不接收上一会话的迟到回溯点", async () => {
    let resolveFirst!: (value: Array<{ promptIndex: number; promptPreview: string }>) => void;
    vi.mocked(rewindPoints)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce([{ promptIndex: 1, promptPreview: "session B" }]);

    const { rerender } = render(<RewindBar sessionId="A" />);
    fireEvent.click(screen.getByRole("button", { name: /\u56de\u6eaf/ }));
    await waitFor(() => expect(rewindPoints).toHaveBeenCalledWith("A"));

    rerender(<RewindBar sessionId="B" />);
    await waitFor(() => expect(screen.getByRole("button", { name: /\u56de\u6eaf/ })).toHaveAttribute("aria-expanded", "false"));
    fireEvent.click(screen.getByRole("button", { name: /\u56de\u6eaf/ }));
    expect(await screen.findByText("session B")).toBeInTheDocument();

    await act(async () => resolveFirst([{ promptIndex: 0, promptPreview: "session A" }]));
    expect(screen.queryByText("session A")).toBeNull();
    expect(screen.getByText("session B")).toBeInTheDocument();
  });

  it("切换会话时作废旧分叉确认，不操作上一会话", async () => {
    const { rerender } = render(<RewindBar sessionId="A" />);
    fireEvent.click(screen.getByRole("button", { name: /分叉/ }));
    expect(screen.getByRole("dialog", { name: "分叉此会话？" })).toBeInTheDocument();

    rerender(<RewindBar sessionId="B" />);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "分叉此会话？" })).toBeNull());
    expect(sessionFork).not.toHaveBeenCalled();
  });

  it("回溯点加载失败显示可重试错误", async () => {
    vi.mocked(rewindPoints).mockRejectedValueOnce(new Error("offline"));
    render(<RewindBar sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: /\u56de\u6eaf/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("offline");
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });

  it("时间线弹窗具有初始焦点、Tab 圈定、Escape 与触发器恢复", async () => {
    render(<RewindBar sessionId="s1" />);
    const trigger = screen.getByRole("button", { name: /回溯/ });
    trigger.focus();
    fireEvent.click(trigger);

    const selectedMode = screen.getByRole("button", { name: "全量" });
    expect(selectedMode).toHaveFocus();
    const action = await screen.findByRole("button", { name: /回溯到此处/ });
    action.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(screen.getByRole("button", { name: "刷新回溯点" })).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "回溯时间线" })).toBeNull();
    expect(trigger).toHaveFocus();
  });
});
