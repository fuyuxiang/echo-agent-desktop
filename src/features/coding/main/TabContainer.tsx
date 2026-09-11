import { AlertTriangle, ChevronRight, FileCode2, FileText, LoaderCircle, X } from "lucide-react";

import { isDirty, isFileTab, type DocTabKind, type FileTab, type WorkbenchTab } from "../store/tab-store";
import { CodingEditor, type CodingEditorDiagnostic, type EditorSymbol } from "./CodingEditor";

interface TabContainerProps {
  tabs: WorkbenchTab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onDraftChange: (id: string, draft: string) => void;
  onSave: (id: string) => void;
  onViewChange: (id: string, view: FileTab["view"]) => void;
  onDiagnostics?: (path: string, diagnostics: CodingEditorDiagnostic[]) => void;
  onSymbols?: (path: string, symbols: EditorSymbol[]) => void;
  renderDoc: (kind: DocTabKind) => React.ReactNode;
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
  onDiagnostics,
  onSymbols,
  renderDoc,
  reveal,
}: TabContainerProps) {
  const active = tabs.find((tab) => tab.id === activeId) ?? null;

  if (tabs.length === 0) {
    return (
      <div className="coding-tabs coding-tabs--empty">
        <FileCode2 size={26} />
        <p>从资源管理器打开文件，或用 ⌘P 快速查找</p>
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
            <button
              type="button"
              className={active.view === "edit" ? "is-active" : ""}
              onClick={() => onViewChange(active.id, "edit")}
            >
              编辑
            </button>
            <button
              type="button"
              className={active.view === "diff" ? "is-active" : ""}
              onClick={() => onViewChange(active.id, "diff")}
            >
              差异
            </button>
          </div>
        </div>
      )}

      {active && isFileTab(active) && active.conflict && (
        <div className="coding-tabs__conflict" role="alert">
          <AlertTriangle size={13} />
          文件已被 Agent 或其他程序修改。保存会覆盖对方的改动，建议先切到差异视图核对。
        </div>
      )}

      <div className="coding-tabs__body">
        {!active && <div className="coding-tabs__empty-body">选择一个标签页</div>}
        {active && !isFileTab(active) && renderDoc(active.kind)}
        {active && isFileTab(active) && active.loading && (
          <div className="coding-tabs__empty-body">
            <LoaderCircle size={15} className="is-spinning" />
            正在打开…
          </div>
        )}
        {active && isFileTab(active) && active.error && (
          <div className="coding-tabs__empty-body is-error">
            <AlertTriangle size={15} />
            {active.error}
          </div>
        )}
        {active && isFileTab(active) && !active.loading && !active.error && (
          <CodingEditor
            path={active.id}
            language={active.language}
            original={active.original}
            value={active.draft}
            mode={active.view}
            reveal={reveal}
            onChange={(draft) => onDraftChange(active.id, draft)}
            onSave={() => onSave(active.id)}
            onDiagnostics={onDiagnostics}
            onSymbols={onSymbols}
          />
        )}
      </div>
    </div>
  );
}
