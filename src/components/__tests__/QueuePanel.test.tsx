import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueuePanel } from "../QueuePanel";
import { useMessageQueueStore } from "@/stores/message-queue-store";

const resetStore = () => useMessageQueueStore.setState({ queues: {} });

describe("QueuePanel", () => {
  beforeEach(resetStore);

  it("空队列时不渲染", () => {
    const { container } = render(<QueuePanel sessionId="s1" />);
    expect(container.firstChild).toBeNull();
  });

  it("渲染队列条目并显示序号与文本", () => {
    const s = useMessageQueueStore.getState();
    s.enqueue("s1", "第一条");
    s.enqueue("s1", "第二条");
    render(<QueuePanel sessionId="s1" />);
    expect(screen.getByText("待发送队列(2)")).toBeInTheDocument();
    expect(screen.getByText("第一条")).toBeInTheDocument();
    expect(screen.getByText("第二条")).toBeInTheDocument();
  });

  it("删除按钮从队列移除条目", () => {
    const s = useMessageQueueStore.getState();
    s.enqueue("s1", "第一条");
    render(<QueuePanel sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(useMessageQueueStore.getState().getQueue("s1")).toHaveLength(0);
  });

  it("点击文本进入编辑,Enter 提交修改", () => {
    const s = useMessageQueueStore.getState();
    s.enqueue("s1", "原文");
    render(<QueuePanel sessionId="s1" />);
    fireEvent.click(screen.getByText("原文"));
    const edit = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(edit, { target: { value: "改后" } });
    fireEvent.keyDown(edit, { key: "Enter", shiftKey: false });
    expect(useMessageQueueStore.getState().getQueue("s1")[0].text).toBe("改后");
  });

  it("暂停/恢复切换状态", () => {
    const s = useMessageQueueStore.getState();
    s.enqueue("s1", "条目");
    render(<QueuePanel sessionId="s1" />);
    const toggle = screen.getByRole("button", { name: "暂停" });
    fireEvent.click(toggle);
    expect(useMessageQueueStore.getState().getQueue("s1")[0].status).toBe("paused");
    // 切换后按钮文案变为「恢复」。
    fireEvent.click(screen.getByRole("button", { name: "恢复" }));
    expect(useMessageQueueStore.getState().getQueue("s1")[0].status).toBe("queued");
  });

  it("上移/下移调整顺序", () => {
    const s = useMessageQueueStore.getState();
    s.enqueue("s1", "a");
    s.enqueue("s1", "b");
    render(<QueuePanel sessionId="s1" />);
    // 第二条上移。
    const ups = screen.getAllByRole("button", { name: "上移" });
    fireEvent.click(ups[1]);
    expect(
      useMessageQueueStore.getState().getQueue("s1").map((i) => i.text),
    ).toEqual(["b", "a"]);
  });

  it("立即发送:运行时接受后才移除条目", async () => {
    const s = useMessageQueueStore.getState();
    s.enqueue("s1", "马上发");
    const onSendNow = vi.fn();
    render(<QueuePanel sessionId="s1" onSendNow={onSendNow} />);
    fireEvent.click(screen.getByRole("button", { name: "立即发送" }));
    expect(onSendNow).toHaveBeenCalledWith("马上发", []);
    await waitFor(() => {
      expect(useMessageQueueStore.getState().getQueue("s1")).toHaveLength(0);
    });
  });

  it("运行时拒绝或发送失败时保留队列项", async () => {
    const s = useMessageQueueStore.getState();
    s.enqueue("s1", "不能丢");
    render(<QueuePanel sessionId="s1" onSendNow={() => Promise.resolve(false)} />);
    fireEvent.click(screen.getByRole("button", { name: "立即发送" }));
    await waitFor(() => {
      expect(useMessageQueueStore.getState().getQueue("s1")).toHaveLength(1);
    });
  });

  it("流式回复时发送操作改为置顶，不删除消息", () => {
    const s = useMessageQueueStore.getState();
    s.enqueue("s1", "a");
    s.enqueue("s1", "b");
    const onSendNow = vi.fn();
    render(<QueuePanel sessionId="s1" streaming onSendNow={onSendNow} />);
    fireEvent.click(screen.getByRole("button", { name: "设为下一条自动发送" }));
    expect(onSendNow).not.toHaveBeenCalled();
    expect(useMessageQueueStore.getState().getQueue("s1").map((item) => item.text)).toEqual(["b", "a"]);
  });

  it("paused 条目的立即发送按钮禁用", () => {
    const s = useMessageQueueStore.getState();
    const id = s.enqueue("s1", "暂停的");
    s.setStatus("s1", id, "paused");
    render(<QueuePanel sessionId="s1" onSendNow={vi.fn()} />);
    expect(screen.getByRole("button", { name: "立即发送" })).toBeDisabled();
  });

  it("已被后台取出的条目显示发送中且不可编辑或删除", () => {
    const s = useMessageQueueStore.getState();
    s.enqueue("s1", "正在发送");
    s.claimNext("s1");
    render(<QueuePanel sessionId="s1" streaming />);

    expect(screen.getByText("正在发送")).toHaveAttribute("title", "发送中");
    expect(screen.getByRole("button", { name: "删除" })).toBeDisabled();
    fireEvent.click(screen.getByText("正在发送"));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("展示队列附件并在发送时保留", async () => {
    useMessageQueueStore.getState().enqueue("s1", "请优化", ["/tmp/方案.docx"]);
    const onSendNow = vi.fn();
    render(<QueuePanel sessionId="s1" onSendNow={onSendNow} />);
    expect(screen.getByText("📎 方案.docx")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "立即发送" }));
    expect(onSendNow).toHaveBeenCalledWith("请优化", ["/tmp/方案.docx"]);
    await waitFor(() => expect(useMessageQueueStore.getState().getQueue("s1")).toHaveLength(0));
  });
});
