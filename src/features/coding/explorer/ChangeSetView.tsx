import { Check, FolderGit2, GitCommitHorizontal, LoaderCircle, RotateCcw, Trash2 } from "lucide-react";

import type { ChangeSet, FileChange } from "../lib/types";

interface ChangeSetViewProps {
  changeSet: ChangeSet | null;
  hasTask: boolean;
  busyPath?: string | null;
  committing?: boolean;
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
 * Files that were already dirty before the task started are listed separately
 * and cannot be discarded here: they are the user's own work, and the task has
 * no claim on them.
 */
export function ChangeSetView({
  changeSet,
  hasTask,
  busyPath,
  committing = false,
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
  const taskChanges = changes.filter((change) => !change.preExisting);
  const userChanges = changes.filter((change) => change.preExisting);
  const reviewed = new Set(changeSet?.reviewedFiles ?? []);
  const totalAdded = taskChanges.reduce((sum, change) => sum + change.added, 0);
  const totalRemoved = taskChanges.reduce((sum, change) => sum + change.removed, 0);
  const unreviewed = taskChanges.filter((change) => !reviewed.has(change.path)).length;

  return (
    <div className="coding-explorer-view">
      <div className="coding-changeset__summary">
        <span>
          <b>{taskChanges.length}</b> 个文件
        </span>
        <span className="is-added">+{totalAdded}</span>
        <span className="is-removed">-{totalRemoved}</span>
        <span>
          已审阅 {taskChanges.length - unreviewed}/{taskChanges.length}
        </span>
      </div>

      <div className="coding-changeset__actions">
        <button
          type="button"
          disabled={taskChanges.length === 0 || committing}
          onClick={onCommit}
        >
          {committing ? <LoaderCircle size={12} className="is-spinning" /> : <GitCommitHorizontal size={12} />}
          提交
        </button>
        <button type="button" disabled={taskChanges.length === 0} onClick={onRollback}>
          <RotateCcw size={12} />
          回滚任务
        </button>
      </div>

      {taskChanges.length === 0 && (
        <div className="coding-row">本任务尚未产生代码变更</div>
      )}

      <div className="coding-changeset__list">
        {taskChanges.map((change) => (
          <div key={change.path} className="coding-changeset__row">
            <button type="button" onClick={() => onOpenDiff(change)} title={change.path}>
              <em className={`is-${change.kind}`}>{STATUS_LETTER[change.kind]}</em>
              <span>{change.path.split("/").pop()}</span>
              <small>{change.path}</small>
              {reviewed.has(change.path) && <Check size={11} aria-label="已审阅" />}
              <b>
                <span className="is-added">+{change.added}</span>
                <span className="is-removed">-{change.removed}</span>
              </b>
            </button>
            <button
              type="button"
              className="coding-changeset__discard"
              disabled={busyPath === change.path}
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

      {userChanges.length > 0 && (
        <>
          <div className="coding-changeset__section">
            任务开始前的改动 · 受保护
          </div>
          <div className="coding-changeset__list">
            {userChanges.map((change) => (
              <div key={change.path} className="coding-changeset__row is-protected">
                <button type="button" onClick={() => onOpenDiff(change)} title={change.path}>
                  <em className={`is-${change.kind}`}>{STATUS_LETTER[change.kind]}</em>
                  <span>{change.path.split("/").pop()}</span>
                  <small>{change.path}</small>
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
