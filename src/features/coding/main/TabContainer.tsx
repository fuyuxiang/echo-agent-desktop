import { AlertTriangle, Check, ChevronRight, FileCode2, FileText, LoaderCircle, X } from "lucide-react";
import type { editor as Monaco } from "monaco-editor";

import { shortcutLabel } from "@/lib/platform";

import type { EditorCodeContext } from "../lib/documentation";
import { isDirty, isFileTab, isVirtualTab, type DocTabKind, type FileTab, type VirtualTab, type WorkbenchTab } from "../store/tab-store";
import { CodingEditor, type CodingEditorDiagnostic, type EditorSymbol } from "./CodingEditor";

interface TabContainerProps {
  tabs: WorkbenchTab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onDraftChange: (id: string, draft: string) => void;
  onSave: (id: string) => void;
  onViewChange: (id: string, view: FileTab["view"]) => void | Promise<void>;
  viewBusy?: boolean;
  reviewBusy?: boolean;
  reviewedPath?: string;
  onMarkReviewed?: (tab: FileTab) => void | Promise<void>;
  onReload?: (id: string) => void;
  onSymbolAction?: (action: "definition" | "references" | "impact", symbol: string) => void;
  onDiagnostics?: (path: string, diagnostics: CodingEditorDiagnostic[]) => void;
  onSymbols?: (path: string, symbols: EditorSymbol[]) => void;
  onEditorContext?: (context: EditorCodeContext) => void;
  onGenerateDocumentation?: (context?: EditorCodeContext) => void;
  /** Controlled switch for the active editor's minimap characters vs colored blocks. */
  minimapRenderCharacters?: boolean;
  /** Fires when the caller toggles the minimap characters; emitted by the editor's settings. */
  onMinimapRenderCharactersChange?: (next: boolean) => void;
  /** Cursor position forwarded from the active editor to the workbench footer status bar. */
  onCursorChange?: (cursor: { line: number; column: number }) => void;
  /** Language/EOL forwarded from the active editor to the workbench footer status bar. */
  onLanguageChange?: (info: { language: string; eol: "LF" | "CRLF" }) => void;
  /** Monaco editor instance, forwarded so the workbench footer can apply EOL / indent changes directly. */
  onEditorReady?: (editor: Monaco.IStandaloneCodeEditor) => void;
  renderDoc: (kind: DocTabKind) => React.ReactNode;
  renderVirtual?: (tab: VirtualTab) => React.ReactNode;
  reveal?: { line: number; column: number; key: number };
}

/** Path segments shown above the editor, VS Code style. */
function Breadcrumb({ tab }: { tab: FileTab }) {
  const segments = tab.relativePath.split("/").filter(Boolean);
  return (
    <div className="coding-breadcrumb" aria-label="文件路径">
      {segments.map((segment, index) => (
        <span key={`${segment}:${index}`}>
          {index > 0 && <ChevronRight size={11} />}
          {segment}
        </span>
      ))}
    </div>
  );
}

/**
 * Single-slot tab area holding both real files and workbench-generated
 * documents (delivery report, task DAG, project profile). Treating reports as
 * ordinary tabs is what keeps them out of the always-visible chrome.
 */
export function TabContainer({
  tabs,
  activeId,
  onSelect,
  onClose,
  onDraftChange,
  onSave,
  onViewChange,
  viewBusy = false,
  reviewBusy = false,
  reviewedPath,
  onMarkReviewed,
  onReload,
  onSymbolAction,
  onDiagnostics,
  onSymbols,
  onEditorContext,
  onGenerateDocumentation,
  minimapRenderCharacters,
  onMinimapRenderCharactersChange,
  onCursorChange,
  onLanguageChange,
  onEditorReady,
  renderDoc,
  renderVirtual,
  reveal,
}: TabContainerProps) {
  const active = tabs.find((tab) => tab.id === activeId) ?? null;

  if (tabs.length === 0) {
    return (
      <div className="coding-tabs coding-tabs--empty">
        <FileCode2 size={26} />
        <p>从资源管理器打开文件，或用 {shortcutLabel("⌘P", "Ctrl+P")} 快速查找</p>
      </div>
    );
  }

  return (
    <div className="coding-tabs">
      <div className="coding-tabs__strip" role="tablist" aria-label="打开的标签页">
        {tabs.map((tab) => {
          const dirty = isDirty(tab);
          return (
            <div
              key={tab.id}
              className={`coding-tabs__tab${tab.id === activeId ? " is-active" : ""}`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={tab.id === activeId}
                onClick={() => onSelect(tab.id)}
                title={isFileTab(tab) ? tab.relativePath : tab.title}
              >
                {isFileTab(tab) ? <FileCode2 size={12} /> : <FileText size={12} />}
                <span>{isFileTab(tab) ? tab.name : tab.title}</span>
                {dirty && <b aria-label="未保存">●</b>}
              </button>
              <button
                type="button"
                className="coding-tabs__close"
                onClick={() => onClose(tab.id)}
                aria-label={`关闭 ${isFileTab(tab) ? tab.name : tab.title}`}
              >
                <X size={11} />
              </button>
            </div>
          );
        })}
      </div>

      {active && isFileTab(active) && (
        <div className="coding-tabs__toolbar">
          <Breadcrumb tab={active} />
          <div className="coding-tabs__views" role="group" aria-label="文件视图">
            {active.view === "diff" && active.diffTaskId && onMarkReviewed && (
              <button
                type="button"
                className={reviewedPath === active.relativePath ? "is-reviewed" : ""}
                disabled={reviewBusy || reviewedPath === active.relativePath}
                onClick={() => void onMarkReviewed(active)}
                title={reviewedPath === active.relativePath
                  ? "该内容版本已审阅；文件变化后需重新审阅"
                  : "确认已检查当前差异"}
              >
                {reviewBusy ? <LoaderCircle size={11} className="is-spinning" /> : <Check size={11} />}
                {reviewedPath === active.relativePath ? "已审阅" : "标记已审阅"}
              </button>
            )}
            <button
              type="button"
              onClick={() => onGenerateDocumentation?.()}
              disabled={active.view === "diff" || active.draft !== active.original || viewBusy}
              title={active.view === "diff"
                ? "请先切换到编辑视图，再让 Agent 生成注释"
                : active.draft !== active.original
                  ? "请先保存当前文件，再让 Agent 生成注释"
                  : viewBusy
                    ? "正在刷新文件差异，请稍候"
                    : `为当前选区、光标符号或文件生成注释（${shortcutLabel("⌘⌥D", "Ctrl+Alt+D")}）`}
              aria-label="为当前选区或符号生成注释"
            >
              <FileText size={11} /> 注释
            </button>
            <button
              type="button"
              className={active.view === "edit" ? "is-active" : ""}
              onClick={() => void onViewChange(active.id, "edit")}
            >
              编辑
            </button>
            <button
              type="button"
              className={active.view === "diff" ? "is-active" : ""}
              onClick={() => void onViewChange(active.id, "diff")}
              disabled={viewBusy}
              aria-busy={viewBusy}
              aria-label={viewBusy ? "正在加载最新差异" : "差异"}
            >
              {viewBusy && <LoaderCircle size={11} className="is-spinning" />}
              {viewBusy ? "刷新中…" : "差异"}
            </button>
          </div>
        </div>
      )}

      {active && isFileTab(active) && active.conflict && (
        <div className="coding-tabs__conflict" role="alert">
          <AlertTriangle size={13} />
          文件已被 Agent 或其他程序修改，当前草稿已过期，不能直接保存。请先核对差异或重新加载。
          {onReload && (
            <button type="button" onClick={() => onReload(active.id)}>
              放弃本地草稿并重新加载
            </button>
          )}
        </div>
      )}

      <div className="coding-tabs__body">
        {!active && <div className="coding-tabs__empty-body">选择一个标签页</div>}
        {active && !isFileTab(active) && !isVirtualTab(active) && renderDoc(active.kind)}
        {active && isVirtualTab(active) && (renderVirtual ? renderVirtual(active) : (
          <div className="coding-tabs__empty-body">该标签页暂未支持</div>
        ))}
        {active && isFileTab(active) && active.loading && (
          <div className="coding-tabs__empty-body">
            <LoaderCircle size={15} className="is-spinning" />
            正在打开…
          </div>
        )}
        {active && isFileTab(active) && active.error && (
          <div className="coding-tabs__empty-body is-error" role="alert">
            <AlertTriangle size={15} />
            <span>{active.error}</span>
            {onReload && (
              <button type="button" onClick={() => onReload(active.id)}>
                重试
              </button>
            )}
          </div>
        )}
        {active && isFileTab(active) && !active.loading && !active.error && (
          <CodingEditor
            path={active.id}
            language={active.language}
            original={active.view === "diff" ? (active.diffOriginal ?? active.original) : active.original}
            value={active.view === "diff" ? (active.diffModified ?? active.draft) : active.draft}
            mode={active.view}
            readOnly={active.view === "diff" && active.diffModified !== undefined}
            reveal={reveal}
            minimapRenderCharacters={minimapRenderCharacters}
            onMinimapRenderCharactersChange={onMinimapRenderCharactersChange}
            onCursorChange={onCursorChange}
            onLanguageChange={onLanguageChange}
            onEditorReady={onEditorReady}
            onChange={(draft) => onDraftChange(active.id, draft)}
            onSave={() => onSave(active.id)}
            onDiagnostics={onDiagnostics}
            onSymbols={onSymbols}
            onSymbolAction={onSymbolAction}
            onContextChange={(context) => onEditorContext?.({
              ...context,
              path: active.relativePath,
            })}
            onDocumentationAction={(context) => onGenerateDocumentation?.({
              ...context,
              path: active.relativePath,
            })}
          />
        )}
      </div>
    </div>
  );
}
