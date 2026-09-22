import { describe, expect, it, vi } from "vitest";
import type * as monaco from "monaco-editor";

// Capture every setLanguageConfiguration call the bootstrap module makes at
// import time. monaco-editor 0.52 does NOT expose getLanguageConfiguration
// on the public `monaco.languages` API, so we record calls instead of reading
// state back. The bootstrap module runs the for-loop before any test code
// executes, so the spy must be installed before the module is imported.
const setLanguageConfigurationCalls = vi.hoisted<
  Array<[string, monaco.languages.LanguageConfiguration]>
>(() => []);

vi.mock("monaco-editor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("monaco-editor")>();
  return {
    ...actual,
    languages: {
      ...actual.languages,
      setLanguageConfiguration: (
        id: string,
        config: monaco.languages.LanguageConfiguration,
      ) => {
        setLanguageConfigurationCalls.push([id, config]);
        return actual.languages.setLanguageConfiguration(id, config);
      },
    },
  };
});

// The bootstrap module wires five `?worker` imports that vite resolves to
// inline worker bundles. jsdom has no Worker constructor, so stub them with
// lightweight classes — we never construct one in this test.
vi.mock("monaco-editor/esm/vs/editor/editor.worker?worker", () => ({
  default: class EditorWorkerStub {},
}));
vi.mock("monaco-editor/esm/vs/language/css/css.worker?worker", () => ({
  default: class CssWorkerStub {},
}));
vi.mock("monaco-editor/esm/vs/language/html/html.worker?worker", () => ({
  default: class HtmlWorkerStub {},
}));
vi.mock("monaco-editor/esm/vs/language/json/json.worker?worker", () => ({
  default: class JsonWorkerStub {},
}));
vi.mock("monaco-editor/esm/vs/language/typescript/ts.worker?worker", () => ({
  default: class TypeScriptWorkerStub {},
}));

const { initializeMonaco } = await import("../monaco-bootstrap");

const EXPECTED_LANGUAGE_IDS = [
  "typescript",
  "javascript",
  "rust",
  "java",
  "kotlin",
  "python",
  "go",
  "c",
  "cpp",
  "csharp",
  "html",
  "css",
  "scss",
  "less",
  "json",
  "markdown",
  "mdx",
  "xml",
  "yaml",
  "shell",
  "sql",
  "ini",
];

describe("monaco-bootstrap language registry", () => {
  it("registers every language id returned by the Rust editor_language() mapper", async () => {
    const monaco = await initializeMonaco();
    const registered = new Set(monaco.languages.getLanguages().map((entry) => entry.id));
    for (const id of EXPECTED_LANGUAGE_IDS) {
      expect(registered.has(id), `missing language id: ${id}`).toBe(true);
    }
  }, 20_000);
});

describe("monaco language configuration", () => {
  const CONFIGURED_IDS = ["yaml", "shell", "sql", "python", "go", "rust"];

  it.each(CONFIGURED_IDS)(
    "registers %s with comments and autoClosingPairs",
    (id) => {
      const matching = setLanguageConfigurationCalls.find(
        ([calledId]) => calledId === id,
      );
      expect(matching, `language ${id} has no configuration`).toBeDefined();
      const [, config] = matching as [string, Record<string, unknown>];
      expect(
        config.comments || config.brackets || config.autoClosingPairs,
        `language ${id} configuration is missing required fields`,
      ).toBeDefined();
    },
  );
});

