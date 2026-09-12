import { useEffect, useRef } from "react";
import Editor, { DiffEditor, type BeforeMount, type DiffOnMount, type OnMount } from "@monaco-editor/react";
import type { IDisposable, editor as MonacoEditor } from "monaco-editor";

import { useTheme } from "@/components/ThemeProvider";

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
}

function editorModelUri(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  if (/^[a-z]:\//i.test(normalized)) return `file:///${normalized}`;
  if (normalized.startsWith("//")) return `file:${normalized}`;
  return `file://${normalized.startsWith("/") ? "" : "/"}${normalized}`;
}

const configureMonaco: BeforeMount = (monaco) => {
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
}: CodingEditorProps) {
  const { theme } = useTheme();
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const diagnosticsDisposableRef = useRef<IDisposable | null>(null);
  const diagnosticsHandlerRef = useRef(onDiagnostics);
  const symbolsHandlerRef = useRef(onSymbols);
  const saveHandlerRef = useRef(onSave);
  const changeHandlerRef = useRef(onChange);
  const symbolActionHandlerRef = useRef(onSymbolAction);

  useEffect(() => {
    diagnosticsHandlerRef.current = onDiagnostics;
    symbolsHandlerRef.current = onSymbols;
    saveHandlerRef.current = onSave;
    changeHandlerRef.current = onChange;
    symbolActionHandlerRef.current = onSymbolAction;
  }, [onChange, onDiagnostics, onSave, onSymbolAction, onSymbols]);

  useEffect(() => {
    if (!reveal || !editorRef.current) return;
    const position = { lineNumber: reveal.line, column: reveal.column };
    editorRef.current.setPosition(position);
    editorRef.current.revealPositionInCenter(position);
    editorRef.current.focus();
  }, [reveal]);

  useEffect(() => () => diagnosticsDisposableRef.current?.dispose(), []);

  const publishSymbols = (
    editor: MonacoEditor.IStandaloneCodeEditor,
    monaco: Parameters<OnMount>[1],
  ) => {
    const model = editor.getModel();
    if (!model || !symbolsHandlerRef.current) return;
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
            ) => Promise<Array<{ name: string; detail?: string; range: { startLineNumber: number } }>>;
          }>;
        };
      }
    ).DocumentSymbolProviderRegistry;
    if (!provider) {
      symbolsHandlerRef.current(path, []);
      return;
    }
    const providers = provider.all(model);
    void Promise.all(
      providers.map((entry) => entry.provideDocumentSymbols?.(model) ?? Promise.resolve([])),
    ).then((results) => {
      const symbols = results.flat().map((symbol) => ({
        name: symbol.name,
        detail: symbol.detail,
        line: symbol.range.startLineNumber,
      }));
      symbolsHandlerRef.current?.(path, symbols);
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
    editorRef.current = editor;
    registerDiagnostics(editor, monaco);
    publishSymbols(editor, monaco);
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
    if (reveal) {
      const position = { lineNumber: reveal.line, column: reveal.column };
      editor.setPosition(position);
      editor.revealPositionInCenter(position);
    }
    editor.focus();
  };

  const registerDiff: DiffOnMount = (editor, monaco) => {
    const modified = editor.getModifiedEditor();
    editorRef.current = modified;
    registerDiagnostics(modified, monaco);
    modified.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
      saveHandlerRef.current(),
    );
    modified.onDidChangeModelContent(() => changeHandlerRef.current(modified.getValue()));
    if (reveal) {
      const position = { lineNumber: reveal.line, column: reveal.column };
      modified.setPosition(position);
      modified.revealPositionInCenter(position);
    }
    modified.focus();
  };

  const monacoTheme = theme === "dark" ? "vs-dark" : "vs";

  const sharedOptions = {
    automaticLayout: true,
    fontFamily: "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace",
    fontSize: 13,
    lineHeight: 21,
    minimap: { enabled: true, maxColumn: 90, renderCharacters: false },
    padding: { top: 10, bottom: 10 },
    renderWhitespace: "selection" as const,
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
