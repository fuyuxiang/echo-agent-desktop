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

  it("inherits Monaco's complete language rules while applying the Echo palette", () => {
    const defineTheme = vi.fn();
    installEchoMonacoThemes({ editor: { defineTheme } } as never);

    expect(defineTheme).toHaveBeenCalledTimes(4);
    for (const [name, theme] of defineTheme.mock.calls) {
      expect(Object.values(ECHO_MONACO_THEMES)).toContain(name);
      expect(theme.inherit).toBe(true);
      expect(theme.encodedTokensColors).toBeUndefined();
      expect(theme.rules).toEqual(expect.arrayContaining([
        expect.objectContaining({ token: "keyword" }),
        expect.objectContaining({ token: "string" }),
        expect.objectContaining({ token: "comment" }),
        expect.objectContaining({ token: "number" }),
      ]));
      expect(theme.colors["editorCursor.foreground"]).toMatch(/^#[0-9A-F]{6}$/i);
      expect(theme.colors["editor.selectionBackground"]).toMatch(/^#[0-9A-F]{6}$/i);
    }
  });

  it("requires a real multi-color Monaco token map instead of accepting a stale marker", () => {
    const style = document.createElement("style");
    style.className = "monaco-colors";
    document.head.append(style);

    expect(hasMonacoRuntimeThemeStyles()).toBe(false);
    style.textContent = ".mtk1 { color: #24292f; }";
    expect(hasMonacoRuntimeThemeStyles()).toBe(false);
    style.textContent += ".mtk2 { color: #24292f; }";
    expect(hasMonacoRuntimeThemeStyles()).toBe(false);
    style.textContent += ".mtk3 { color: #cf222e; }";
    expect(hasMonacoRuntimeThemeStyles()).toBe(true);

    style.remove();
  });
});
