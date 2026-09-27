import { useState } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { SecondarySidebar } from "../SecondarySidebar";
import { agentsList } from "@/lib/agent-client";
import { useModalFocus } from "@/lib/use-modal-focus";

vi.mock("@/lib/agent-client", () => ({
  agentsList: vi.fn(),
}));

const mockAgents = [
  { name: "小圆子", description: "主持人", scope: "user", path: "/a", raw: "", modelTags: ["default"] },
  { name: "小坦克", description: "审计员", scope: "user", path: "/b", raw: "", modelTags: ["default"] },
  { name: "小玄子", description: "撰稿", scope: "user", path: "/c", raw: "", modelTags: ["default"] },
  { name: "小灵通", description: "翻译", scope: "user", path: "/d", raw: "", modelTags: ["default"] },
];

beforeEach(() => {
  // 用真实 setImmediate 推进 Promise,但仍用 fake timers 控制 setTimeout。
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.mocked(agentsList).mockResolvedValue(mockAgents);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

async function settle() {
  // 让 agentsList 微任务 resolve + hover-peek 100ms 定时器触发。
  await act(async () => {
    await Promise.resolve();
    vi.advanceTimersByTime(200);
    await Promise.resolve();
  });
}

function TestDialog({ onClose }: { onClose: () => void }) {
  const ref = useModalFocus<HTMLDivElement>(true, onClose);
  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label="测试弹窗" tabIndex={-1}>
      <button type="button" data-modal-initial-focus onClick={onClose}>关闭测试弹窗</button>
    </div>
  );
}

function ModalHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>打开测试弹窗</button>
      <SecondarySidebar onSelectExpert={vi.fn()} onToast={vi.fn()} />
      {open && <TestDialog onClose={() => setOpen(false)} />}
    </>
  );
}

describe("SecondarySidebar", () => {
  it("面板首次打开即渲染默认预览，切换助理时复用预览块", async () => {
    render(<SecondarySidebar onSelectExpert={vi.fn()} onToast={vi.fn()} />);
    await settle();

    const trigger = document.querySelector(".secondary-sidebar__trigger") as HTMLElement;
    expect(trigger).toBeTruthy();
    fireEvent.mouseEnter(trigger);
    await settle();

    const floating = document.querySelector(".secondary-sidebar__floating") as HTMLElement;
    expect(floating).toBeTruthy();
    const initialPreview = document.querySelector(".secondary-sidebar__preview");
    expect(initialPreview).toBeTruthy();
    expect(initialPreview).toHaveTextContent("小圆子");
    const buttons = document.querySelectorAll(".secondary-sidebar__item-btn") as NodeListOf<HTMLElement>;
    expect(buttons.length).toBeGreaterThanOrEqual(4);

    fireEvent.mouseEnter(buttons[1]);
    const previewAfterTransition = document.querySelector(".secondary-sidebar__preview");
    expect(previewAfterTransition).toBe(initialPreview);
    expect(previewAfterTransition).toHaveTextContent("小坦克");
  });

  it("鼠标离开所有 item 后,预览块应保持挂载", async () => {
    render(<SecondarySidebar onSelectExpert={vi.fn()} onToast={vi.fn()} />);
    await settle();

    const trigger = document.querySelector(".secondary-sidebar__trigger") as HTMLElement;
    fireEvent.mouseEnter(trigger);
    await settle();

    const floating = document.querySelector(".secondary-sidebar__floating") as HTMLElement;
    expect(floating).toBeTruthy();
    const buttons = document.querySelectorAll(".secondary-sidebar__item-btn") as NodeListOf<HTMLElement>;
    expect(buttons.length).toBeGreaterThanOrEqual(4);

    const previewAfterHover = document.querySelector(".secondary-sidebar__preview");
    expect(previewAfterHover).toHaveTextContent("小圆子");

    // 鼠标完全离开所有 item。期望:预览保持挂载,面板高度稳定。
    fireEvent.mouseLeave(buttons[0]);
    const previewAfterLeave = document.querySelector(".secondary-sidebar__preview");
    expect(previewAfterLeave).toBeTruthy();
  });

  it("键盘聚焦助理时同步更新预览", async () => {
    render(<SecondarySidebar onSelectExpert={vi.fn()} onToast={vi.fn()} />);
    await settle();

    const trigger = document.querySelector(".secondary-sidebar__trigger") as HTMLElement;
    fireEvent.mouseEnter(trigger);
    await settle();

    const buttons = document.querySelectorAll(".secondary-sidebar__item-btn") as NodeListOf<HTMLElement>;
    fireEvent.focus(buttons[2]);

    expect(document.querySelector(".secondary-sidebar__preview")).toHaveTextContent("小玄子");
  });

  it("空列表提供创建入口，重新打开后读取新创建的专家", async () => {
    const onCreateExpert = vi.fn();
    vi.mocked(agentsList).mockResolvedValueOnce([]).mockResolvedValueOnce(mockAgents);
    render(<SecondarySidebar onCreateExpert={onCreateExpert} />);

    const trigger = document.querySelector(".secondary-sidebar__trigger") as HTMLElement;
    fireEvent.mouseEnter(trigger);
    await settle();
    expect(screen.getByText("还没有可选专家")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "创建专家" }));
    expect(onCreateExpert).toHaveBeenCalledOnce();
    expect(document.querySelector(".secondary-sidebar__floating")).toBeNull();

    fireEvent.mouseEnter(trigger);
    await settle();
    expect(screen.getByRole("button", { name: /小圆子/ })).toBeInTheDocument();
    expect(agentsList).toHaveBeenCalledTimes(2);
  });

  it("键盘聚焦右侧入口也能打开并使用创建按钮", async () => {
    vi.mocked(agentsList).mockResolvedValueOnce([]);
    const onCreateExpert = vi.fn();
    render(<SecondarySidebar onCreateExpert={onCreateExpert} />);
    const trigger = screen.getByRole("button", { name: "快速选择专家" });
    fireEvent.focus(trigger);
    await settle();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: "创建专家" }));
    expect(onCreateExpert).toHaveBeenCalledOnce();
  });

  it("加载失败时显示重试，不误报专家为空", async () => {
    vi.mocked(agentsList).mockRejectedValueOnce(new Error("网络错误")).mockResolvedValueOnce([]);
    render(<SecondarySidebar onCreateExpert={vi.fn()} />);
    fireEvent.mouseEnter(document.querySelector(".secondary-sidebar__trigger") as HTMLElement);
    await settle();
    expect(screen.getByText("专家加载失败")).toBeInTheDocument();
    expect(screen.queryByText("还没有可选专家")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await settle();
    expect(screen.getByText("还没有可选专家")).toBeInTheDocument();
  });

  it("弹窗打开时移除全局悬浮入口和面板，关闭后不恢复旧 hover 状态", async () => {
    render(<ModalHarness />);
    await settle();

    const trigger = document.querySelector(".secondary-sidebar__trigger") as HTMLElement;
    fireEvent.mouseEnter(trigger);
    await settle();
    expect(document.querySelector(".secondary-sidebar__floating")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "打开测试弹窗" }));
    await settle();
    expect(screen.getByRole("dialog", { name: "测试弹窗" })).toBeInTheDocument();
    expect(document.querySelector(".secondary-sidebar__trigger")).toBeNull();
    expect(document.querySelector(".secondary-sidebar__floating")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "关闭测试弹窗" }));
    await settle();
    expect(document.querySelector(".secondary-sidebar__trigger")).toBeTruthy();
    expect(document.querySelector(".secondary-sidebar__floating")).toBeNull();
  });
});
