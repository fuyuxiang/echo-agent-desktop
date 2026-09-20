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
