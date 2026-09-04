/** Local memory browser/editor backed by the embedded Runtime's canonical storage. */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  BookIcon,
  SearchIcon,
  AddIcon,
  EditToolIcon,
  DeleteIcon,
  RefreshCwIcon,
  SparklesIcon,
} from "@/foundation/components/Icon/icons";
import {
  memoryAppend,
  memoryDelete,
  memoryDream,
  memoryFlush,
  memoryList,
  memoryRewrite,
  memorySave,
} from "@/lib/agent-client";
import type { MemoryEntry } from "@/lib/types";
import { useModalFocus } from "@/lib/use-modal-focus";
import { useAppDialog } from "./AppDialog";

interface ResourcesPanelProps {
  cwd?: string;
  sessionId?: string;
  onToast?: (msg: string) => void;
}

interface EditorState {
  scope: MemoryEntry["scope"];
  path: string;
  content: string;
  revision: string;
  isNew: boolean;
  readOnly: boolean;
}

function errorText(error: unknown): string {
  return String(error).replace(/^Error:\s*/, "");
}

function scopeLabel(scope: MemoryEntry["scope"]): string {
  if (scope === "global") return "全局";
  if (scope === "workspace") return "工作区";
  return "会话记录";
}

export function ResourcesPanel({ cwd, sessionId, onToast }: ResourcesPanelProps) {
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<EditorState | null>(null);
  const [busy, setBusy] = useState(false);
  const { requestConfirmation, dialog } = useAppDialog(JSON.stringify([cwd ?? null, sessionId ?? null]));
  const reloadGeneration = useRef(0);

  const reload = useCallback(async () => {
    const generation = ++reloadGeneration.current;
    setLoading(true);
    setLoadError(null);
    try {
      const next = await memoryList(cwd);
      if (reloadGeneration.current === generation) setEntries(next);
    } catch (error) {
      if (reloadGeneration.current !== generation) return;
      const message = errorText(error);
      setLoadError(message);
      onToast?.(`加载个人记忆失败：${message}`);
    } finally {
      if (reloadGeneration.current === generation) setLoading(false);
    }
  }, [cwd, onToast]);

  useEffect(() => {
    void reload();
    return () => {
      reloadGeneration.current += 1;
    };
  }, [reload]);

  const handleSave = useCallback(async (draft: EditorState) => {
    if (!draft.content.trim()) {
      onToast?.("记忆内容不能为空");
      return;
    }
    if (draft.scope === "session") {
      onToast?.("会话记忆由 Agent 自动生成，只能查看");
      return;
    }
    setBusy(true);
    try {
      if (draft.isNew) {
        await memoryAppend(draft.scope, draft.content, cwd);
        onToast?.("已追加记忆");
      } else {
        await memorySave(
          draft.scope,
          draft.path,
          draft.content,
          cwd,
          draft.revision,
        );
        onToast?.("已保存记忆");
      }
      setEditing(null);
      await reload();
    } catch (error) {
      onToast?.(`保存失败：${errorText(error)}`);
    } finally {
      setBusy(false);
    }
  }, [cwd, onToast, reload]);

  const handleDelete = useCallback((entry: MemoryEntry) => {
    if (entry.readOnly) return;
    requestConfirmation({
      title: `删除${scopeLabel(entry.scope)}记忆文件？`,
      description: `将永久删除“${entry.path}”，此操作无法撤销。`,
      confirmLabel: "删除记忆",
      danger: true,
      action: async () => {
        setBusy(true);
        try {
          await memoryDelete(entry.scope, entry.path, cwd, entry.revision);
          setEntries((current) => current.filter((candidate) => !(
            candidate.scope === entry.scope && candidate.path === entry.path
          )));
          onToast?.("已删除记忆文件");
          await reload();
        } finally {
          setBusy(false);
        }
      },
      onError: (error) => onToast?.(`删除失败：${errorText(error)}`),
    });
  }, [cwd, onToast, reload, requestConfirmation]);

  const handleFlush = useCallback(async () => {
    if (!sessionId) {
      onToast?.("立即落盘需要一个已打开的会话");
      return;
    }
    setBusy(true);
    try {
      await memoryFlush(sessionId);
      await reload();
    } catch (error) {
      onToast?.(`落盘失败：${errorText(error)}`);
    } finally {
      setBusy(false);
    }
  }, [onToast, reload, sessionId]);

  const handleDream = useCallback(() => {
    if (!sessionId) {
      onToast?.("整理记忆需要一个已打开的会话");
      return;
    }
    requestConfirmation({
      title: "整理历史会话记忆？",
      description: "Agent 会把历史会话记录归纳到长期记忆中，可能会修改现有记忆内容。",
      confirmLabel: "开始整理",
      action: async () => {
        setBusy(true);
        try {
          await memoryDream(sessionId);
          await reload();
        } finally {
          setBusy(false);
        }
      },
      onError: (error) => onToast?.(`整理失败：${errorText(error)}`),
    });
  }, [onToast, reload, requestConfirmation, sessionId]);

  const handleRewriteDraft = useCallback(async (draft: EditorState) => {
    if (!sessionId) {
      onToast?.("AI 整理需要一个已打开的会话");
      return;
    }
    setBusy(true);
    try {
      const rewritten = await memoryRewrite(
        sessionId,
        draft.content,
        `${scopeLabel(draft.scope)}记忆 ${draft.path}`,
      );
      setEditing((current) => current ? { ...current, content: rewritten } : current);
      onToast?.("已生成整理结果，请检查后保存");
    } catch (error) {
      onToast?.(`AI 整理失败：${errorText(error)}`);
    } finally {
      setBusy(false);
    }
  }, [onToast, sessionId]);

  const normalizedQuery = query.trim().toLowerCase();
  const filtered = entries.filter((entry) =>
    !normalizedQuery
    || entry.path.toLowerCase().includes(normalizedQuery)
    || entry.content.toLowerCase().includes(normalizedQuery)
  );
  const globalCount = entries.filter((entry) => entry.scope === "global").length;
  const workspaceCount = entries.filter((entry) => entry.scope === "workspace").length;
  const sessionCount = entries.filter((entry) => entry.scope === "session").length;

  return (
    <div className="resources-panel">
      <div className="resources-panel__header">
        <div>
          <h2 className="resources-panel__title">个人记忆</h2>
          <p className="resources-panel__subtitle">管理跨会话偏好、项目上下文和 Agent 自动生成的会话记录</p>
        </div>
        <div className="resources-panel__header-actions">
          <button className="resources-panel__action-btn" onClick={handleFlush} disabled={busy || !sessionId} title="提取当前会话中的长期信息并立即写入磁盘">
            落盘
          </button>
          <button className="resources-panel__action-btn" onClick={handleDream} disabled={busy || !sessionId} title="把历史会话记录归纳为长期记忆">
            <SparklesIcon size="sm" /> 整理
          </button>
          <button className="resources-panel__action-btn" onClick={() => void reload()} disabled={loading} title="刷新">
            <RefreshCwIcon size="sm" /> 刷新
          </button>
        </div>
      </div>

      <div className="resources-panel__search">
        <SearchIcon size="md" className="resources-panel__search-icon" />
        <input className="resources-panel__search-input" aria-label="搜索记忆" placeholder="搜索记忆…" value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>

      <div className="resources-panel__stats">
        <span>全局 {globalCount}</span>
        {cwd && <span>· 工作区 {workspaceCount}</span>}
        {cwd && <span>· 会话记录 {sessionCount}</span>}
      </div>

      {loadError && (
        <div className="panel-inline-error" role="alert">
          <span>个人记忆加载失败：{loadError}</span>
          <button type="button" onClick={() => void reload()} disabled={loading}>
            {loading ? "重试中…" : "重试"}
          </button>
        </div>
      )}

      <button
        className="resources-panel__create-btn"
        onClick={() => setEditing({
          scope: cwd ? "workspace" : "global",
          path: "MEMORY.md",
          content: "",
          revision: "",
          isNew: true,
          readOnly: false,
        })}
      >
        <AddIcon size="sm" /> 添加一条记忆
      </button>

      <div className="resources-panel__list">
        {!loading && !loadError && filtered.length === 0 && (
          <div className="resources-panel__empty">
            <BookIcon size="xl" color="var(--echo-text-tertiary)" />
            <p>暂无记忆。可手动添加，也可在对话中使用 <code>/remember</code> 保存。</p>
          </div>
        )}
        {filtered.map((entry) => (
          <div key={`${entry.scope}/${entry.path}`} className="resources-panel__item">
            <div className="resources-panel__item-icon"><BookIcon size="md" /></div>
            <div className="resources-panel__item-content">
              <div className="resources-panel__item-name">
                {entry.path}
                <span className="resources-panel__item-scope">{scopeLabel(entry.scope)}</span>
              </div>
              <pre className="resources-panel__item-preview">
                {entry.content.slice(0, 200)}{entry.content.length > 200 ? "…" : ""}
              </pre>
            </div>
            <div className="resources-panel__item-actions">
              <button
                className="resources-panel__icon-btn"
                onClick={() => setEditing({ ...entry, isNew: false })}
                title={entry.readOnly ? "查看" : "编辑"}
              >
                <EditToolIcon size="sm" />
              </button>
              {!entry.readOnly && (
                <button className="resources-panel__icon-btn resources-panel__icon-btn--danger" onClick={() => void handleDelete(entry)} title="删除">
                  <DeleteIcon size="sm" />
                </button>
              )}
            </div>
          </div>
        ))}
        {loading && <div className="resources-panel__empty">加载中…</div>}
      </div>

      {editing && (
        <MemoryEditor
          draft={editing}
          cwd={cwd}
          canRewrite={Boolean(sessionId) && !editing.readOnly}
          busy={busy}
          onChange={setEditing}
          onCancel={() => setEditing(null)}
          onRewrite={() => void handleRewriteDraft(editing)}
          onSave={() => void handleSave(editing)}
        />
      )}
      {dialog}
    </div>
  );
}

function MemoryEditor({
  draft,
  cwd,
  canRewrite,
  busy,
  onChange,
  onCancel,
  onRewrite,
  onSave,
}: {
  draft: EditorState;
  cwd?: string;
  canRewrite: boolean;
  busy: boolean;
  onChange: (draft: EditorState) => void;
  onCancel: () => void;
  onRewrite: () => void;
  onSave: () => void;
}) {
  const dialogRef = useModalFocus<HTMLDivElement>(true, onCancel);
  const dialogLabel = draft.isNew ? "添加记忆" : `${draft.readOnly ? "查看" : "编辑"} ${draft.path}`;

  return (
    <div className="modal-overlay memory-editor__overlay" onClick={onCancel}>
      <div ref={dialogRef} className="memory-editor" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label={dialogLabel} tabIndex={-1}>
        <div className="memory-editor__header">
          <h3>{draft.isNew ? "添加记忆" : `${draft.readOnly ? "查看" : "编辑"} ${draft.path}`}</h3>
          <button className="memory-editor__close" onClick={onCancel} aria-label="关闭">✕</button>
        </div>
        <div className="memory-editor__meta">
          <label>
            范围
            <select
              value={draft.scope}
              disabled={!draft.isNew}
              onChange={(event) => onChange({ ...draft, scope: event.target.value as EditorState["scope"] })}
            >
              <option value="global">全局记忆</option>
              {cwd && <option value="workspace">当前工作区</option>}
              {draft.scope === "session" && <option value="session">会话记录（只读）</option>}
            </select>
          </label>
          <label>
            文件
            <input type="text" value={draft.path} disabled />
          </label>
        </div>
        <textarea
          className="memory-editor__content"
          aria-label={draft.isNew ? "记忆内容" : `记忆内容 ${draft.path}`}
          value={draft.content}
          readOnly={draft.readOnly}
          onChange={(event) => onChange({ ...draft, content: event.target.value })}
          placeholder={draft.isNew ? "例如：代码示例优先使用 TypeScript，并说明关键设计取舍。" : undefined}
          spellCheck={false}
          data-modal-initial-focus
        />
        <div className="memory-editor__footer">
          <button className="btn btn--ghost" onClick={onCancel}>{draft.readOnly ? "关闭" : "取消"}</button>
          {!draft.readOnly && (
            <>
              <button className="btn btn--ghost" disabled={busy || !canRewrite || !draft.content.trim()} onClick={onRewrite} title={canRewrite ? "使用当前会话模型整理这份文本" : "需要一个已打开的会话"}>
                {busy ? "处理中…" : "AI 整理"}
              </button>
              <button className="btn btn--primary" disabled={busy || !draft.content.trim()} onClick={onSave}>
                {busy ? "保存中…" : draft.isNew ? "添加" : "保存"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
