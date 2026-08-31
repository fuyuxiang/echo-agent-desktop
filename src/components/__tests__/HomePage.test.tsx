import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { HomePage } from "../HomePage";

const base = {
  onSend: vi.fn(),
  streaming: false,
  apiReady: true,
  onOpenSettings: vi.fn(),
  onPlaceholder: vi.fn(),
};

describe("HomePage", () => {
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
});
