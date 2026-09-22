import { useEffect, useRef, useState } from "react";
import Editor, { DiffEditor, type BeforeMount, type DiffOnMount, type OnMount } from "@monaco-editor/react";
import type { IDisposable, editor as MonacoEditor } from "monaco-editor";
import { AlertTriangle, LoaderCircle } from "lucide-react";

import { useTheme } from "@/components/ThemeProvider";
import { reportEvent } from "@/lib/telemetry-contract";
import type { EditorCodeContext } from "../lib/documentation";
import { initializeMonaco } from "../lib/monaco-bootstrap";
import {
  hasMonacoRuntimeThemeStyles,
  installEchoMonacoThemes,
  resolveEchoMonacoTheme,
  type EchoMonacoTheme,
} from "../lib/monaco-theme";

export interface CodingEditorDiagnostic {
  path: string;
  message: string;
  severity: "error" | "warning";
  line: number;
  column: number;
}

export interface EditorSymbol {
  name: string;
  detail?: string;
  line: number;
  endLine?: number;
}

interface CodingEditorProps {
  path: string;
  language: string;
  original: string;
  value: string;
  mode: "edit" | "diff";
  readOnly?: boolean;
  reveal?: { line: number; column: number; key: number };
  onChange: (value: string) => void;
  onSave: () => void;
  onDiagnostics?: (path: string, diagnostics: CodingEditorDiagnostic[]) => void;
  /** Document symbols for the breadcrumb and the ⌘T palette. */
  onSymbols?: (path: string, symbols: EditorSymbol[]) => void;
  onSymbolAction?: (action: "definition" | "references" | "impact", symbol: string) => void;
  /** Current selection/caret context used by conversational code actions. */
  onContextChange?: (context: EditorCodeContext) => void;
  /** Context-menu/shortcut entry for the same documentation flow as /doc. */
  onDocumentationAction?: (context: EditorCodeContext) => void;
  /** Controlled switch for rendering minimap characters vs colored blocks. */
  minimapRenderCharacters?: boolean;
  /** Fires when the caller toggles the minimap characters; surface for the workbench settings. */
  onMinimapRenderCharactersChange?: (next: boolean) => void;
  /** Cursor position listener for the workbench footer status bar. */
  onCursorChange?: (cursor: { line: number; column: number }) => void;
  /** Language/EOL listener for the workbench footer status bar. */
  onLanguageChange?: (info: { language: string; eol: "LF" | "CRLF" }) => void;
}

interface OutlineSymbol {
  name: string;
  detail?: string;
  startLine: number;
  endLine: number;
}

interface DocumentSymbolLike {
  name: string;
  detail?: string;
  range: { startLineNumber: number; endLineNumber?: number };
  children?: DocumentSymbolLike[];
}

const MAX_SELECTION_CONTEXT = 12_000;
const MONACO_STARTUP_TIMEOUT_MS = 10_000;
const FORCED_COLORS_QUERY = "(forced-colors: active)";

export const MINIMAP_DEFAULTS = {
  enabled: true,
  maxColumn: 120,
  renderCharacters: true,
  showSlider: "mouseover" as const,
  side: "right" as const,
  scale: 1,
} satisfies NonNullable<MonacoEditor.IEditorOptions["minimap"]>;

let themeFallbackReported = false;

type MonacoStartupState =
  | { status: "loading" }
  | { status: "ready" }
  | { status: "error"; detail: string };

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  const message = String(error).trim();
  return message && message !== "[object Object]" ? message : "未知初始化错误";
}

function editorModelUri(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  if (/^[a-z]:\//i.test(normalized)) return `file:///${normalized}`;
  if (normalized.startsWith("//")) return `file:${normalized}`;
  return `file://${normalized.startsWith("/") ? "" : "/"}${normalized}`;
}

function forcedColorsAreActive(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia(FORCED_COLORS_QUERY).matches;
}

function scheduleThemeHealthCheck(
  monaco: Parameters<OnMount>[1],
  themeName: EchoMonacoTheme,
): void {
  const schedule = typeof window.requestAnimationFrame === "function"
    ? window.requestAnimationFrame.bind(window)
    : (callback: FrameRequestCallback) => window.setTimeout(callback, 0);

  schedule(() => {
    if (hasMonacoRuntimeThemeStyles()) return;
    // Re-applying the theme repairs transient WebView style injection failures.
    // Monaco must remain the single owner of its generated `.mtk*` color map;
    // a static index-based override can silently flatten all syntax colors.
    monaco.editor.setTheme(themeName);
    schedule(() => {
      if (hasMonacoRuntimeThemeStyles() || themeFallbackReported) return;
      themeFallbackReported = true;
      console.warn("[EchoAgent] Monaco runtime theme styles are unavailable; syntax colors may be degraded");
      reportEvent("coding.editor.theme_styles_missing", "warn", { theme: themeName });
    });
  });
}

const configureMonaco: BeforeMount = (monaco) => {
  installEchoMonacoThemes(monaco);
  monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
    allowNonTsExtensions: true,
    allowJs: true,
    jsx: monaco.languages.typescript.JsxEmit.ReactJSX,
    moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
    target: monaco.languages.typescript.ScriptTarget.ES2020,
  });
  monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
  });
};

/**
 * Monaco wrapper for the workbench.
 *
 * Unlike the previous implementation this follows the application theme instead
 * of pinning `vs-dark`, so the editor no longer sits as a dark rectangle inside
 * a light workbench.
 */
export function CodingEditor({
  path,
  language,
  original,
  value,
  mode,
  readOnly = false,
  reveal,
  onChange,
  onSave,
  onDiagnostics,
  onSymbols,
  onSymbolAction,
  onContextChange,
  onDocumentationAction,
  minimapRenderCharacters,
  onMinimapRenderCharactersChange,
  onCursorChange,
  onLanguageChange,
}: CodingEditorProps) {
  // `onMinimapRenderCharactersChange` is the controlled-input counterpart of
  // `minimapRenderCharacters`; the parent wires its own state setter through it
  // and the editor reacts to prop changes via the `useEffect` below.
  void onMinimapRenderCharactersChange;
  const { theme } = useTheme();
  const [forcedColors, setForcedColors] = useState(forcedColorsAreActive);
  const [startup, setStartup] = useState<MonacoStartupState>({ status: "loading" });
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const diagnosticsDisposableRef = useRef<IDisposable | null>(null);
  const selectionDisposableRef = useRef<IDisposable | null>(null);
  const documentationActionDisposableRef = useRef<IDisposable | null>(null);
  const outlineSymbolsRef = useRef<OutlineSymbol[]>([]);
  const symbolsGenerationRef = useRef(0);
  const diagnosticsHandlerRef = useRef(onDiagnostics);
  const symbolsHandlerRef = useRef(onSymbols);
  const saveHandlerRef = useRef(onSave);
  const changeHandlerRef = useRef(onChange);
  const symbolActionHandlerRef = useRef(onSymbolAction);
  const contextHandlerRef = useRef(onContextChange);
  const documentationActionHandlerRef = useRef(onDocumentationAction);
  const minimapRenderCharactersRef = useRef(minimapRenderCharacters);
  const cursorChangeHandlerRef = useRef(onCursorChange);
  const languageChangeHandlerRef = useRef(onLanguageChange);

  useEffect(() => {
    diagnosticsHandlerRef.current = onDiagnostics;
    symbolsHandlerRef.current = onSymbols;
    saveHandlerRef.current = onSave;
    changeHandlerRef.current = onChange;
    symbolActionHandlerRef.current = onSymbolAction;
    contextHandlerRef.current = onContextChange;
    documentationActionHandlerRef.current = onDocumentationAction;
  }, [onChange, onContextChange, onDiagnostics, onDocumentationAction, onSave, onSymbolAction, onSymbols]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(FORCED_COLORS_QUERY);
    const update = () => setForcedColors(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);

  useEffect(() => {
    let active = true;
    let settled = false;
    const fail = (cause: unknown) => {
      if (!active || settled) return;
      settled = true;
      const detail = errorMessage(cause);
      console.error("[EchoAgent] Monaco editor initialization failed", cause);
      reportEvent("coding.editor.initialization_failed", "error", { detail });
      setStartup({ status: "error", detail });
    };
    const timeoutId = window.setTimeout(
      () => fail(new Error("本地编辑器资源初始化超时")),
      MONACO_STARTUP_TIMEOUT_MS,
    );
    void initializeMonaco().then(() => {
      if (!active || settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      setStartup({ status: "ready" });
    }).catch(fail);
    return () => {
      active = false;
      window.clearTimeout(timeoutId);
    };
  }, []);

  useEffect(() => {
    if (!reveal || !editorRef.current) return;
    const position = { lineNumber: reveal.line, column: reveal.column };
    editorRef.current.setPosition(position);
    editorRef.current.revealPositionInCenter(position);
    editorRef.current.focus();
  }, [reveal]);

  useEffect(() => {
    minimapRenderCharactersRef.current = minimapRenderCharacters;
    editorRef.current?.updateOptions({
      minimap: {
        ...MINIMAP_DEFAULTS,
        renderCharacters: minimapRenderCharacters ?? MINIMAP_DEFAULTS.renderCharacters,
      },
    });
  }, [minimapRenderCharacters]);

  useEffect(() => () => {
    symbolsGenerationRef.current += 1;
    diagnosticsDisposableRef.current?.dispose();
    selectionDisposableRef.current?.dispose();
    documentationActionDisposableRef.current?.dispose();
  }, []);

  const editorContext = (editor: MonacoEditor.IStandaloneCodeEditor): EditorCodeContext | null => {
    const model = editor.getModel();
    const selection = editor.getSelection();
    const position = editor.getPosition();
    if (!model || !selection || !position) return null;
    const rawSelection = selection.isEmpty() ? "" : model.getValueInRange(selection);
    const symbol = outlineSymbolsRef.current
      .filter((entry) => entry.startLine <= position.lineNumber && entry.endLine >= position.lineNumber)
      .sort((left, right) =>
        (left.endLine - left.startLine) - (right.endLine - right.startLine),
      )[0];
    return {
      path,
      language: model.getLanguageId(),
      cursorLine: position.lineNumber,
      cursorColumn: position.column,
      startLine: selection.startLineNumber,
      startColumn: selection.startColumn,
      endLine: selection.endLineNumber,
      endColumn: selection.endColumn,
      selectedText: rawSelection.slice(0, MAX_SELECTION_CONTEXT),
      selectionTruncated: rawSelection.length > MAX_SELECTION_CONTEXT,
      symbol: symbol
        ? {
            name: symbol.name,
            kind: symbol.detail,
            startLine: symbol.startLine,
            endLine: symbol.endLine,
          }
        : undefined,
    };
  };

  const publishEditorContext = (editor: MonacoEditor.IStandaloneCodeEditor) => {
    const context = editorContext(editor);
    if (context) contextHandlerRef.current?.(context);
    return context;
  };

  const publishSymbols = (
    editor: MonacoEditor.IStandaloneCodeEditor,
    monaco: Parameters<OnMount>[1],
  ) => {
    const model = editor.getModel();
    if (!model) return;
    const generation = ++symbolsGenerationRef.current;
    outlineSymbolsRef.current = [];
    void monaco.languages
      .getLanguages()
      .find((entry) => entry.id === model.getLanguageId());
    // Monaco exposes symbols through the quick-outline provider; read them from
    // the model's own outline when available and degrade to an empty list.
    const provider = (
      monaco.languages as unknown as {
        DocumentSymbolProviderRegistry?: {
          all: (model: MonacoEditor.ITextModel) => Array<{
            provideDocumentSymbols?: (
              model: MonacoEditor.ITextModel,
            ) => Promise<DocumentSymbolLike[]>;
          }>;
        };
      }
    ).DocumentSymbolProviderRegistry;
    if (!provider) {
      symbolsHandlerRef.current?.(path, []);
      return;
    }
    const providers = provider.all(model);
    void Promise.all(
      providers.map((entry) => Promise.resolve().then(
        () => entry.provideDocumentSymbols?.(model) ?? [],
      )),
    ).then((results) => {
      if (generation !== symbolsGenerationRef.current || editor.getModel() !== model) return;
      const flatten = (entries: DocumentSymbolLike[]): OutlineSymbol[] => entries.flatMap((symbol) => {
        const current: OutlineSymbol = {
          name: symbol.name,
          detail: symbol.detail,
          startLine: symbol.range.startLineNumber,
          endLine: symbol.range.endLineNumber ?? symbol.range.startLineNumber,
        };
        return [current, ...flatten(symbol.children ?? [])];
      });
      const flattened = results.flatMap((result) => flatten(result));
      outlineSymbolsRef.current = flattened;
      const symbols = flattened.map((symbol) => ({
        name: symbol.name,
        detail: symbol.detail,
        line: symbol.startLine,
        endLine: symbol.endLine,
      }));
      symbolsHandlerRef.current?.(path, symbols);
      publishEditorContext(editor);
    }).catch(() => {
      if (generation !== symbolsGenerationRef.current || editor.getModel() !== model) return;
      outlineSymbolsRef.current = [];
      symbolsHandlerRef.current?.(path, []);
      publishEditorContext(editor);
    });
  };

  const registerDiagnostics = (
    editor: MonacoEditor.IStandaloneCodeEditor,
    monaco: Parameters<OnMount>[1],
  ) => {
    diagnosticsDisposableRef.current?.dispose();
    const publish = () => {
      const model = editor.getModel();
      if (!model) return;
      const diagnostics = monaco.editor
        .getModelMarkers({ resource: model.uri })
        .filter(
          (marker) =>
            marker.severity === monaco.MarkerSeverity.Error ||
            marker.severity === monaco.MarkerSeverity.Warning,
        )
        .map((marker): CodingEditorDiagnostic => ({
          path,
          message: marker.message,
          severity: marker.severity === monaco.MarkerSeverity.Error ? "error" : "warning",
          line: marker.startLineNumber,
          column: marker.startColumn,
        }));
      diagnosticsHandlerRef.current?.(path, diagnostics);
    };
    diagnosticsDisposableRef.current = monaco.editor.onDidChangeMarkers((resources) => {
      const model = editor.getModel();
      if (model && resources.some((resource) => resource.toString() === model.uri.toString())) {
        publish();
      }
    });
    publish();
  };

  const registerSave: OnMount = (editor, monaco) => {
    monaco.editor.setTheme(monacoTheme);
    scheduleThemeHealthCheck(monaco, monacoTheme);
    editorRef.current = editor;
    registerDiagnostics(editor, monaco);
    publishSymbols(editor, monaco);
    // Cursor context for the workbench footer status bar.
    editor.onDidChangeCursorPosition((event) => {
      cursorChangeHandlerRef.current?.({
        line: event.position.lineNumber,
        column: event.position.column,
      });
    });
    // Language / EOL context for the workbench footer status bar.
    const model = editor.getModel();
    if (model) {
      model.onDidChangeLanguage(() => {
        languageChangeHandlerRef.current?.({
          language: model.getLanguageId(),
          eol: model.getEOL() === "\r\n" ? "CRLF" : "LF",
        });
      });
      // Publish once on mount so the footer reflects the current language.
      languageChangeHandlerRef.current?.({
        language: model.getLanguageId(),
        eol: model.getEOL() === "\r\n" ? "CRLF" : "LF",
      });
    }
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
      saveHandlerRef.current(),
    );
    const runSymbolAction = (action: "definition" | "references" | "impact") => {
      const position = editor.getPosition();
      const model = editor.getModel();
      const symbol = position && model ? model.getWordAtPosition(position)?.word : undefined;
      if (symbol) symbolActionHandlerRef.current?.(action, symbol);
    };
    editor.addAction({
      id: "echo-code.definition",
      label: "Echo Code: 跳转到定义",
      keybindings: [monaco.KeyCode.F12],
      run: () => runSymbolAction("definition"),
    });
    editor.addAction({
      id: "echo-code.references",
      label: "Echo Code: 查找引用",
      keybindings: [monaco.KeyMod.Shift | monaco.KeyCode.F12],
      run: () => runSymbolAction("references"),
    });
    editor.addAction({
      id: "echo-code.impact",
      label: "Echo Code: 分析影响",
      keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.F12],
      run: () => runSymbolAction("impact"),
    });
    documentationActionDisposableRef.current?.dispose();
    documentationActionDisposableRef.current = editor.addAction({
      id: "echo-code.documentation",
      label: "Echo Code: 为选区或当前符号生成注释",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyD],
      contextMenuGroupId: "navigation",
      contextMenuOrder: 1.6,
      run: () => {
        const context = publishEditorContext(editor);
        if (context) documentationActionHandlerRef.current?.(context);
      },
    });
    selectionDisposableRef.current?.dispose();
    selectionDisposableRef.current = editor.onDidChangeCursorSelection(() => {
      publishEditorContext(editor);
    });
    if (reveal) {
      const position = { lineNumber: reveal.line, column: reveal.column };
      editor.setPosition(position);
      editor.revealPositionInCenter(position);
    }
    publishEditorContext(editor);
    editor.focus();
  };

  const registerDiff: DiffOnMount = (editor, monaco) => {
    monaco.editor.setTheme(monacoTheme);
    scheduleThemeHealthCheck(monaco, monacoTheme);
    const modified = editor.getModifiedEditor();
    symbolsGenerationRef.current += 1;
    outlineSymbolsRef.current = [];
    editorRef.current = modified;
    registerDiagnostics(modified, monaco);
    // Cursor context for the workbench footer status bar (diff view).
    modified.onDidChangeCursorPosition((event) => {
      cursorChangeHandlerRef.current?.({
        line: event.position.lineNumber,
        column: event.position.column,
      });
    });
    modified.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
      saveHandlerRef.current(),
    );
    modified.onDidChangeModelContent(() => changeHandlerRef.current(modified.getValue()));
    selectionDisposableRef.current?.dispose();
    selectionDisposableRef.current = modified.onDidChangeCursorSelection(() => {
      publishEditorContext(modified);
    });
    if (reveal) {
      const position = { lineNumber: reveal.line, column: reveal.column };
      modified.setPosition(position);
      modified.revealPositionInCenter(position);
    }
    publishEditorContext(modified);
    modified.focus();
  };

  const monacoTheme = resolveEchoMonacoTheme(theme, forcedColors);

  if (startup.status === "loading") {
    return (
      <div className="coding-monaco coding-monaco--state" role="status" aria-live="polite">
        <LoaderCircle size={18} className="is-spinning" />
        <div>
          <strong>正在启动代码编辑器…</strong>
          <small>首次打开可能需要片刻，编辑器资源正在从本地加载。</small>
        </div>
      </div>
    );
  }

  if (startup.status === "error") {
    return (
      <div className="coding-monaco coding-monaco--state is-error" role="alert">
        <AlertTriangle size={18} />
        <div>
          <strong>代码编辑器启动失败</strong>
          <small>文件内容未被修改。请重新加载应用后重试。</small>
          <code>{startup.detail}</code>
        </div>
        <button type="button" onClick={() => window.location.reload()}>
          重新加载
        </button>
      </div>
    );
  }

  const loading = (
    <div className="coding-monaco__inline-loading" role="status">
      <LoaderCircle size={16} className="is-spinning" />
      正在准备编辑器…
    </div>
  );

  const sharedOptions = {
    automaticLayout: true,
    fontFamily: "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace",
    fontSize: 13,
    lineHeight: 21,
    minimap: {
      ...MINIMAP_DEFAULTS,
      renderCharacters: minimapRenderCharacters ?? MINIMAP_DEFAULTS.renderCharacters,
    },
    padding: { top: 10, bottom: 10 },
    experimentalWhitespaceRendering: "off" as const,
    renderWhitespace: "none" as const,
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    tabSize: 2,
    wordWrap: "off" as const,
  };

  if (mode === "diff") {
    return (
      <div className="coding-monaco" aria-label={`${path} 的差异`}>
        <DiffEditor
          key={`diff:${path}`}
          original={original}
          modified={value}
          language={language}
          originalModelPath={`${editorModelUri(path)}?version=original`}
          modifiedModelPath={editorModelUri(path)}
          theme={monacoTheme}
          loading={loading}
          beforeMount={configureMonaco}
          onMount={registerDiff}
          options={{
            ...sharedOptions,
            originalEditable: false,
            readOnly,
            renderSideBySide: true,
            enableSplitViewResizing: true,
          }}
        />
      </div>
    );
  }

  return (
    <div className="coding-monaco" aria-label={`编辑 ${path}`}>
      <Editor
        key={`edit:${path}`}
        path={editorModelUri(path)}
        value={value}
        language={language}
        theme={monacoTheme}
        loading={loading}
        beforeMount={configureMonaco}
        onMount={registerSave}
        onChange={(next) => onChange(next ?? "")}
        options={{
          ...sharedOptions,
          readOnly,
          glyphMargin: true,
          formatOnPaste: true,
          formatOnType: true,
          quickSuggestions: true,
          suggestOnTriggerCharacters: true,
        }}
      />
    </div>
  );
}
