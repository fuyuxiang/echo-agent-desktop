import { Check, FolderGit2, GitCommitHorizontal, LoaderCircle, RotateCcw, Trash2 } from "lucide-react";

import type { ChangeSet, FileChange } from "../lib/types";

interface ChangeSetViewProps {
  changeSet: ChangeSet | null;
  hasTask: boolean;
  busyPath?: string | null;
  committing?: boolean;
  canCommit?: boolean;
  canRollback?: boolean;
  canDiscard?: boolean;
  onOpenDiff: (change: FileChange) => void;
  onDiscard: (change: FileChange) => void;
  onCommit: () => void;
  onRollback: () => void;
}

const STATUS_LETTER: Record<FileChange["kind"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
};

/**
 * The task's change set, which is the unit the workbench commits and rolls back.
 *
 * Files already dirty at task start carry a visible marker. Their exact starting
 * bytes can be restored, but automatic commit stays disabled to avoid sweeping
 * unrelated personal changes into the task commit.
 */
export function ChangeSetView({
  changeSet,
  hasTask,
  busyPath,
  committing = false,
  canCommit = false,
  canRollback = true,
  canDiscard = true,
  onOpenDiff,
  onDiscard,
  onCommit,
  onRollback,
}: ChangeSetViewProps) {
  if (!hasTask) {
    return (
      <div className="coding-explorer-view coding-explorer-view--empty">
        <FolderGit2 size={22} />
        <p>新建开发任务后，Agent 与你的改动会集中显示在这里。</p>
      </div>
    );
  }

  const changes = changeSet?.changes ?? [];
  const reviewed = new Set(changeSet?.reviewedFiles ?? []);
  const totalAdded = changes.reduce((sum, change) => sum + change.added, 0);
  const totalRemoved = changes.reduce((sum, change) => sum + change.removed, 0);
  const unreviewed = changes.filter((change) => !reviewed.has(change.path)).length;
  const hasProtectedChanges = changes.some((change) => change.preExisting);

  return (
    <div className="coding-explorer-view">
      <div className="coding-changeset__summary">
        <span>
          <b>{changes.length}</b> 个文件
        </span>
        <span className="is-added">+{totalAdded}</span>
        <span className="is-removed">-{totalRemoved}</span>
        <span>
          已审阅 {changes.length - unreviewed}/{changes.length}
        </span>
      </div>

      <div className="coding-changeset__actions">
        <button
          type="button"
          disabled={changes.length === 0 || committing || !canCommit || hasProtectedChanges}
          onClick={onCommit}
          title={hasProtectedChanges ? "包含任务开始前已有改动的文件，为避免一并提交，请手动整理后提交" : !canCommit ? "完成验收交付后才能提交" : undefined}
        >
          {committing ? <LoaderCircle size={12} className="is-spinning" /> : <GitCommitHorizontal size={12} />}
          提交
        </button>
        <button type="button" disabled={changes.length === 0 || !canRollback} onClick={onRollback}>
          <RotateCcw size={12} />
          回滚任务
        </button>
      </div>

      {changeSet?.committedHash && (
        <div className="coding-row">已提交：{changeSet.committedHash.slice(0, 12)}</div>
      )}

      {changes.length === 0 && (
        <div className="coding-row">本任务尚未产生代码变更</div>
      )}

      <div className="coding-changeset__list">
        {changes.map((change) => (
          <div key={change.path} className="coding-changeset__row">
            <button type="button" onClick={() => onOpenDiff(change)} title={change.path}>
              <em className={`is-${change.kind}`}>{STATUS_LETTER[change.kind]}</em>
              <span>{change.path.split("/").pop()}</span>
              <small>{change.path}</small>
              {change.preExisting && <small title="任务开始时此文件已有未提交内容">起始时已修改</small>}
              {reviewed.has(change.path) && <Check size={11} aria-label="已审阅" />}
              <b>
                <span className="is-added">+{change.added}</span>
                <span className="is-removed">-{change.removed}</span>
              </b>
            </button>
            <button
              type="button"
              className="coding-changeset__discard"
              disabled={!canDiscard || busyPath === change.path}
              onClick={() => onDiscard(change)}
              aria-label={`丢弃 ${change.path} 的改动`}
              title="丢弃此文件的改动"
            >
              {busyPath === change.path ? (
                <LoaderCircle size={11} className="is-spinning" />
              ) : (
                <Trash2 size={11} />
              )}
            </button>
          </div>
        ))}
      </div>

      {hasProtectedChanges && (
        <div className="coding-explorer__note">
          带“起始时已修改”标记的文件可审阅和精确回滚，但不会被自动提交，以免混入任务开始前的个人改动。
        </div>
      )}
    </div>
  );
}
