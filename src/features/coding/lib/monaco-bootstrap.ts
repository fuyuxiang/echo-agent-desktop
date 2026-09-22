/**
 * Offline Monaco bootstrap for the desktop WebView.
 *
 * `@monaco-editor/react` otherwise falls back to its public jsDelivr loader.
 * That is both unsuitable for an offline desktop application and correctly
 * rejected by our `script-src 'self'` CSP. Supplying the ESM API and explicit
 * Vite workers keeps every editor resource inside the application bundle.
 */
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import TypeScriptWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
// Register the 16 basic-languages our Rust `editor_language()` mapper can
// emit. Without these side-effect imports the minimap loses its syntax
// colors — Monaco's tokenizer only runs for languages that have a
// contribution registered.
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution";
import "monaco-editor/esm/vs/basic-languages/mdx/mdx.contribution";
import "monaco-editor/esm/vs/basic-languages/rust/rust.contribution";
import "monaco-editor/esm/vs/basic-languages/python/python.contribution";
import "monaco-editor/esm/vs/basic-languages/java/java.contribution";
import "monaco-editor/esm/vs/basic-languages/kotlin/kotlin.contribution";
import "monaco-editor/esm/vs/basic-languages/go/go.contribution";
import "monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution";
import "monaco-editor/esm/vs/basic-languages/csharp/csharp.contribution";
import "monaco-editor/esm/vs/basic-languages/scss/scss.contribution";
import "monaco-editor/esm/vs/basic-languages/less/less.contribution";
import "monaco-editor/esm/vs/basic-languages/xml/xml.contribution";
import "monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution";
import "monaco-editor/esm/vs/basic-languages/shell/shell.contribution";
import "monaco-editor/esm/vs/basic-languages/sql/sql.contribution";
import "monaco-editor/esm/vs/basic-languages/ini/ini.contribution";

type MonacoApi = typeof monaco;
type MonacoEnvironment = {
  getWorker?: (workerId: string, label: string) => Worker;
};

const scope = globalThis as typeof globalThis & {
  MonacoEnvironment?: MonacoEnvironment;
};

scope.MonacoEnvironment = {
  ...scope.MonacoEnvironment,
  getWorker: (_workerId, label) => {
    if (label === "json") return new JsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new CssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") {
      return new HtmlWorker();
    }
    if (label === "typescript" || label === "javascript") return new TypeScriptWorker();
    return new EditorWorker();
  },
};

// Configure this before any Editor component mounts. Passing the API directly
// prevents the loader from injecting a remote <script> element.
loader.config({ monaco });

let initialization: Promise<MonacoApi> | null = null;

/** Initialize Monaco once and share the result between edit and diff views. */
export function initializeMonaco(): Promise<MonacoApi> {
  if (!initialization) {
    initialization = Promise.resolve(loader.init())
      .then((instance) => instance as MonacoApi)
      .catch((error: unknown) => {
        initialization = null;
        throw error;
      });
  }
  return initialization;
}
