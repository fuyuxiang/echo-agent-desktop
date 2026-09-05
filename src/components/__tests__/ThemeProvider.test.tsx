// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  THEME_STORAGE_KEY,
  ThemeProvider,
  initializeTheme,
  useTheme,
} from "../ThemeProvider";

function ThemeProbe() {
  const { theme, setTheme } = useTheme();
  return (
    <div>
      <output aria-label="当前主题">{theme}</output>
      <button type="button" onClick={() => setTheme("dark")}>深色</button>
      <button type="button" onClick={() => setTheme("light")}>浅色</button>
    </div>
  );
}

describe("ThemeProvider", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.style.colorScheme = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.style.colorScheme = "";
  });

  it("切换主题时同步文档、原生控件配色和持久化状态", () => {
    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );

    expect(screen.getByLabelText("当前主题")).toHaveTextContent("light");
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(document.documentElement.style.colorScheme).toBe("light");

    fireEvent.click(screen.getByRole("button", { name: "深色" }));

    expect(screen.getByLabelText("当前主题")).toHaveTextContent("dark");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  });

  it("React 挂载前恢复用户保存的深色主题", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");

    expect(initializeTheme()).toBe("dark");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");

    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );
    expect(screen.getByLabelText("当前主题")).toHaveTextContent("dark");
  });

  it("WebView 禁止访问存储时仍能以浅色主题启动和切换", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("storage blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("storage blocked", "SecurityError");
    });

    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );

    expect(screen.getByLabelText("当前主题")).toHaveTextContent("light");
    fireEvent.click(screen.getByRole("button", { name: "深色" }));
    expect(screen.getByLabelText("当前主题")).toHaveTextContent("dark");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  });
});
