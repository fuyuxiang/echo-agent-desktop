// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppErrorBoundary } from "../AppErrorBoundary";

function BrokenView(): never {
  throw new Error("渲染器启动异常");
}

describe("AppErrorBoundary", () => {
  const preventExpectedWindowError = (event: ErrorEvent) => event.preventDefault();

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    window.addEventListener("error", preventExpectedWindowError);
  });
  afterEach(() => {
    window.removeEventListener("error", preventExpectedWindowError);
    vi.restoreAllMocks();
  });

  it("根组件异常时显示可操作错误页而不是白屏", () => {
    render(
      <AppErrorBoundary>
        <BrokenView />
      </AppErrorBoundary>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("界面启动失败");
    expect(screen.getByText("渲染器启动异常")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新加载" })).toBeInTheDocument();
  });
});
