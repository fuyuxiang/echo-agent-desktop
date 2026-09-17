import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { SecondarySidebar } from "../SecondarySidebar";
import { agentsList } from "@/lib/agent-client";

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
});
