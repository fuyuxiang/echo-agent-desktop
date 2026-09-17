import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { HomePage } from "../HomePage";
import { usePendingExpertStore } from "@/stores/pending-expert-store";

const base = {
  onSend: vi.fn(),
  streaming: false,
  apiReady: true,
  onOpenSettings: vi.fn(),
  onPlaceholder: vi.fn(),
};

describe("HomePage", () => {
  beforeEach(() => {
    // 测试间重置 store,避免跨用例污染。
    usePendingExpertStore.setState({ expert: null });
  });

  it("以单一任务问题和输入框作为首页主入口", () => {
    render(<HomePage {...base} />);
    expect(screen.getByRole("heading", { name: "今天想完成什么？" })).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toBeInTheDocument();
    expect(screen.queryByText(/本地 Agent 工作台/)).toBeNull();
    expect(screen.queryByText(/结合当前工作区、模型和工具/)).toBeNull();
    expect(document.querySelector(".home__brand-mark")).toBeNull();
  });

  it("不渲染内置场景、能力和 prompt 模板", () => {
    render(<HomePage {...base} />);
    expect(screen.queryByRole("tablist", { name: "场景" })).toBeNull();
    expect(screen.queryByText("日常办公")).toBeNull();
    expect(screen.queryByText("文档处理")).toBeNull();
    expect(screen.queryByText("财报分析全流程")).toBeNull();
  });

  it("点击移除按钮清空 pending 专家,且不破坏输入框中的预填文字", async () => {
    usePendingExpertStore.getState().set({
      name: "小坦克",
      prompt: "...",
      description: "...",
      expertId: "tank",
      source: "local",
      quickPrompt: "请帮我开始",
    });

    render(<HomePage {...base} />);
    // 召唤触发 quickPrompt 预填。
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(input.value).toBe("请帮我开始");
    // 两处 chip 都有 ×。
    const removeButtons = screen.getAllByRole("button", { name: "移除已选专家" });
    expect(removeButtons.length).toBeGreaterThanOrEqual(2);

    // 点击第一个移除按钮(顶部 chip)。
    act(() => { fireEvent.click(removeButtons[0]); });

    // store 清空 → 两处 chip 消失。
    expect(usePendingExpertStore.getState().expert).toBeNull();
    expect(screen.queryByRole("button", { name: "移除已选专家" })).toBeNull();
    // 输入框已预填的文字保留(只撤销专家身份,不破坏用户文本)。
    expect(input.value).toBe("请帮我开始");
  });

  it("dismiss 后再次召唤同一专家会重新预填 quickPrompt", () => {
    usePendingExpertStore.getState().set({
      name: "小坦克",
      prompt: "...",
      description: "...",
      expertId: "tank",
      source: "local",
      quickPrompt: "请帮我开始",
    });

    render(<HomePage {...base} />);
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(input.value).toBe("请帮我开始");

    // 第一次 dismiss。
    act(() => {
      fireEvent.click(screen.getAllByRole("button", { name: "移除已选专家" })[0]);
    });
    expect(usePendingExpertStore.getState().expert).toBeNull();

    // 用户编辑一下文本,模拟「dismiss 后自己加了一些字」。
    act(() => { fireEvent.change(input, { target: { value: "用户接着改的字" } }); });
    expect(input.value).toBe("用户接着改的字");

    // 重新召唤同一专家。
    act(() => {
      usePendingExpertStore.getState().set({
        name: "小坦克",
        prompt: "...",
        description: "...",
        expertId: "tank",
        source: "local",
        quickPrompt: "请帮我开始",
      });
    });

    // quickPrompt 被重新预填(覆盖用户已改的文字)。
    expect(input.value).toBe("请帮我开始");
  });
});
