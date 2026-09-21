import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  ECHO_MONACO_THEMES,
  hasMonacoRuntimeThemeStyles,
  installEchoMonacoThemes,
  resolveEchoMonacoTheme,
} from "../monaco-theme";

describe("Monaco theme resilience", () => {
  it("selects an app-matched high-contrast theme when forced colors are active", () => {
    expect(resolveEchoMonacoTheme("light", false)).toBe(ECHO_MONACO_THEMES.light);
    expect(resolveEchoMonacoTheme("dark", false)).toBe(ECHO_MONACO_THEMES.dark);
    expect(resolveEchoMonacoTheme("light", true)).toBe(ECHO_MONACO_THEMES.highContrastLight);
    expect(resolveEchoMonacoTheme("dark", true)).toBe(ECHO_MONACO_THEMES.highContrastDark);
  });

  it("installs self-contained themes with a stable fallback token map", () => {
    const defineTheme = vi.fn();
    installEchoMonacoThemes({ editor: { defineTheme } } as never);
    const css = readFileSync(
      resolve(process.cwd(), "src/styles/coding-workbench.css"),
      "utf8",
    ).toLowerCase();

    expect(defineTheme).toHaveBeenCalledTimes(4);
    for (const [name, theme] of defineTheme.mock.calls) {
      expect(Object.values(ECHO_MONACO_THEMES)).toContain(name);
      expect(theme.inherit).toBe(false);
      expect(theme.encodedTokensColors).toHaveLength(11);
      expect(theme.colors["editorCursor.foreground"]).toMatch(/^#[0-9A-F]{6}$/i);
      expect(theme.colors["editor.selectionBackground"]).toMatch(/^#[0-9A-F]{6}$/i);

      const selector = `.coding-monaco .monaco-editor.${name} {`;
      const start = css.indexOf(selector);
      const block = css.slice(start, css.indexOf("}", start));
      expect(start).toBeGreaterThanOrEqual(0);
      theme.encodedTokensColors.forEach((color: string, index: number) => {
        expect(block).toContain(`--echo-monaco-token-${index + 1}: ${color.toLowerCase()};`);
      });
    }
  });

  it("detects whether Monaco actually injected its runtime token styles", () => {
    const style = document.createElement("style");
    style.className = "monaco-colors";
    document.head.append(style);

    expect(hasMonacoRuntimeThemeStyles()).toBe(false);
    style.textContent = ".mtk1 { color: #24292f; }";
    expect(hasMonacoRuntimeThemeStyles()).toBe(true);

    style.remove();
  });
});
