import { describe, expect, it, vi } from "vitest";

import {
  ECHO_MONACO_THEMES,
  hasMonacoRuntimeThemeStyles,
  installEchoMonacoThemes,
} from "../monaco-theme";

describe("Monaco theme rendering integration", () => {
  it("generates distinct syntax token classes and a multi-color runtime stylesheet", async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockImplementation((media: string) => ({
        matches: false,
        media,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    const monaco = await import("monaco-editor/esm/vs/editor/editor.api");
    await import("monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution");
    installEchoMonacoThemes(monaco);

    for (const theme of Object.values(ECHO_MONACO_THEMES)) {
      monaco.editor.setTheme(theme);
      const html = await monaco.editor.colorize(
        "const answer = 42; // highlighted\nconsole.log('ready');",
        "javascript",
        { tabSize: 2 },
      );

      const tokenClasses = new Set(html.match(/mtk\d+/g) ?? []);
      expect(tokenClasses.size, theme).toBeGreaterThan(1);
      expect(hasMonacoRuntimeThemeStyles(), theme).toBe(true);
    }
  }, 15_000);
});
