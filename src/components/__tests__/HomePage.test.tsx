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
  it("渲染品牌区和输入框", () => {
    render(<HomePage {...base} />);
    expect(screen.getByText("EchoAgent")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("不渲染内置场景、能力和 prompt 模板", () => {
    render(<HomePage {...base} />);
    expect(screen.queryByRole("tablist", { name: "场景" })).toBeNull();
    expect(screen.queryByText("日常办公")).toBeNull();
    expect(screen.queryByText("文档处理")).toBeNull();
    expect(screen.queryByText("财报分析全流程")).toBeNull();
  });
});
