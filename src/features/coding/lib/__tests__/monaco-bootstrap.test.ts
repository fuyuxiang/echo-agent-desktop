import { describe, expect, it, vi } from "vitest";

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

