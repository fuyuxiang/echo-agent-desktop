import { useEffect, useRef } from "react";
import Editor, { DiffEditor, type BeforeMount, type DiffOnMount, type OnMount } from "@monaco-editor/react";
import type { IDisposable, editor as MonacoEditor } from "monaco-editor";

import { useTheme } from "@/components/ThemeProvider";
import type { EditorCodeContext } from "../lib/documentation";

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
  onContextChange,
  onDocumentationAction,
}: CodingEditorProps) {
  const { theme } = useTheme();
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
    if (!reveal || !editorRef.current) return;
    const position = { lineNumber: reveal.line, column: reveal.column };
    editorRef.current.setPosition(position);
    editorRef.current.revealPositionInCenter(position);
    editorRef.current.focus();
  }, [reveal]);

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
    const modified = editor.getModifiedEditor();
    symbolsGenerationRef.current += 1;
    outlineSymbolsRef.current = [];
    editorRef.current = modified;
    registerDiagnostics(modified, monaco);
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
