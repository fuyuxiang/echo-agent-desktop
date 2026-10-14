/// <reference types="vite/client" />
import { loader } from "@monaco-editor/react";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import TypeScriptWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

let preparing: Promise<void> | null = null;

/** Use the locked, bundled editor and same-origin workers before mounting React. */
export function prepareLocalMonaco(): Promise<void> {
  if (!preparing) {
    const scope = globalThis as typeof globalThis & {
      MonacoEnvironment?: import("monaco-editor").Environment;
    };
    scope.MonacoEnvironment = {
      ...scope.MonacoEnvironment,
      getWorker: (_moduleId, label) => {
        if (label === "typescript" || label === "javascript") return new TypeScriptWorker();
        if (label === "json") return new JsonWorker();
        if (label === "css" || label === "scss" || label === "less") return new CssWorker();
        if (label === "html" || label === "handlebars" || label === "razor") return new HtmlWorker();
        return new EditorWorker();
      },
    };
    preparing = import("monaco-editor").then(async (monaco) => {
      // Passing the actual ESM instance stops @monaco-editor/loader consulting
      // its remote AMD default, which the desktop's script-src 'self' rejects.
      loader.config({ monaco });
      await loader.init();
    }).catch((error: unknown) => {
      preparing = null;
      throw error;
    });
  }
  return preparing;
}
