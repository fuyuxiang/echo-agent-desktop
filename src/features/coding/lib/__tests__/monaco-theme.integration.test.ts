import { describe, expect, it, vi } from "vitest";

import {
  hasMonacoRuntimeThemeStyles,
  installEchoMonacoThemes,
} from "../monaco-theme";

describe("Monaco theme rendering integration", () => {
  const SAMPLES: Array<[string, string]> = [
    ["typescript", "const answer = 42; // highlighted\nconsole.log('ready');"],
    ["javascript", "const answer = 42; // highlighted\nconsole.log('ready');"],
    ["markdown", "# 标题\n一个段落。\\`代码\\`"],
    ["yaml", "name: hello\nvalue: 42"],
    ["json", '{"name": "hello", "value": 42}'],
    ["rust", "fn main() { let x = 42; println!(\"{}\", x); }"],
    ["python", "def hello():\n    return 42"],
    ["go", "package main\nfunc main() { fmt.Println(\"hi\") }"],
    ["java", "public class A { int x = 42; }"],
    ["kotlin", "fun main() { val x = 42 }"],
    ["csharp", "class A { int X = 42; }"],
    ["c", "int main() { return 42; }"],
    ["cpp", "int main() { return 42; }"],
    ["html", "<div class=\"name\">a</div>"],
    ["css", ".name { color: red; }"],
    ["scss", ".name { $x: 100; color: red; }"],
    ["less", ".name { @x: 100; color: red; }"],
    ["xml", "<root><child name=\"a\"/></root>"],
    ["shell", "#!/bin/bash\necho hello"],
    ["sql", "SELECT * FROM users WHERE id = 1"],
    ["ini", "name = hello\nvalue = 42"],
  ];

  it.each(SAMPLES)(
    "generates at least 2 distinct token classes for %s",
    async (id, code) => {
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
      // Pre-register the language contribution (the production bootstrap
      // does this once at startup; tests load on demand).
      await import(`monaco-editor/esm/vs/basic-languages/${id}/${id}.contribution`).catch(() => null);
      // `c` shares the cpp tokenizer but ships no `c.contribution.js` of
      // its own; the cpp contribution registers both languages lazily.
      if (id === "c") {
        await import("monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution").catch(() => null);
      }
      // json's contribution lives outside `basic-languages/`, and its
      // tokens provider is wired via `monaco.languages.onLanguage` —
      // a hook that the standalone `colorize()` API does not fire on
      // its own. Trigger setupMode() once so the tokenizer is
      // registered before we ask for colorized HTML.
      if (id === "json") {
        await import("monaco-editor/esm/vs/language/json/monaco.contribution").catch(() => null);
        const jsonMode = (await import(
          // monaco-editor ships no .d.ts for the json internals; the
          // `setupMode` function lives only in the runtime bundle.
          // @ts-expect-error -- internal entry has no type declarations
          "monaco-editor/esm/vs/language/json/jsonMode"
        )) as { setupMode: (defaults: unknown) => void };
        const jsonDefaults = (
          monaco.languages as unknown as {
            json?: { jsonDefaults: unknown };
          }
        ).json?.jsonDefaults;
        if (jsonDefaults) {
          jsonMode.setupMode(jsonDefaults);
        }
      }
      installEchoMonacoThemes(monaco);

      const html = await monaco.editor.colorize(code, id, { tabSize: 2 });
      const tokenClasses = new Set(html.match(/mtk\d+/g) ?? []);
      expect(tokenClasses.size, `language ${id} produced no token classes`).toBeGreaterThanOrEqual(2);
      expect(hasMonacoRuntimeThemeStyles()).toBe(true);
    },
    30_000,
  );
});