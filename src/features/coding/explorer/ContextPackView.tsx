import { FileCode2, PackageSearch, Plus, X } from "lucide-react";

interface ContextPackViewProps {
  /** Workspace-relative paths the user pinned as task context. */
  paths: string[];
  scopeLabel?: string;
  /** Path of the file currently open, offered as a one-click addition. */
  activePath?: string;
  onAdd: (path: string) => void;
  onRemove: (path: string) => void;
  onClear?: () => void;
}

/**
 * Files the user pinned as context for the Agent.
 *
 * Automatic context assembly (relevance ranking, token budgeting, dedup) needs
 * the code-intelligence layer and is not in this phase; what the user pins here
 * is passed through explicitly, so the contents are always something they chose.
 */
export function ContextPackView({
  paths,
  scopeLabel = "当前任务",
  activePath,
  onAdd,
  onRemove,
  onClear,
}: ContextPackViewProps) {
  const canAddActive = Boolean(activePath) && !paths.includes(activePath as string);

  return (
    <div className="coding-explorer-view">
      <div className="coding-context__scope">
        <span>{scopeLabel}上下文</span>
        <b>{paths.length} 项</b>
        {paths.length > 0 && onClear && <button type="button" onClick={onClear}>清空</button>}
      </div>
      {canAddActive && (
        <button
          type="button"
          className="coding-context__add"
          onClick={() => onAdd(activePath as string)}
        >
          <Plus size={12} />
          将当前文件加入上下文
        </button>
      )}

      {paths.length === 0 ? (
        <div className="coding-explorer-view--empty">
          <PackageSearch size={22} />
          <p>选定的文件或目录会优先提供给 Agent，未选定时由 Agent 自行检索。</p>
        </div>
      ) : (
        <div className="coding-context__list">
          {paths.map((path) => (
            <div key={path} className="coding-context__row">
              <FileCode2 size={12} />
              <span title={path}>{path}</span>
              <button
                type="button"
                onClick={() => onRemove(path)}
                aria-label={`移除 ${path}`}
                title="移除"
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
