import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PlaceholderPage } from "../PlaceholderPage";

describe("PlaceholderPage", () => {
  it("未注册路由显示明确错误，不伪装成待上线功能", () => {
    render(<PlaceholderPage label="某个未实现功能" />);
    expect(screen.getByRole("heading", { name: "无法打开「某个未实现功能」" })).toBeInTheDocument();
    expect(screen.getByText(/未注册该功能路由/)).toBeInTheDocument();
  });

  it.each(["助理", "灵感", "网页预览", "策略设置", "发现"])(
    "已移除路由「%s」不会再渲染旧功能页",
    (label) => {
      render(<PlaceholderPage label={label} />);
      expect(
        screen.getByRole("heading", { name: `无法打开「${label}」` }),
      ).toBeInTheDocument();
    },
  );
});
