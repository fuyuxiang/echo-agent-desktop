import { useMemo, useState } from "react";
import {
  ArchiveRestore,
  FolderKanban,
  Loader2,
  MessageSquare,
  Search,
  Trash2,
} from "lucide-react";
import { useSessionsStore } from "@/stores/sessions-store";
import { useProjectsStore } from "@/stores/projects-store";
import type { SessionStatus } from "@/lib/types";
import { useAppDialog } from "./AppDialog";

type ArchiveScope = "all" | "standalone" | "project";

interface ArchivedSessionEntry {
  sessionId: string;
  title: string;
  cwd?: string;
  updatedAt?: string;
  status?: SessionStatus;
  projectId?: string;
  projectName?: string;
  relation?: string;
}

interface ArchivedSessionsSettingsPanelProps {
  onRestoreSession?: (sessionId: string, archived: boolean, cwd?: string) => Promise<void>;
  onDeleteSession?: (sessionId: string, cwd?: string) => Promise<void>;
  onOpenSession?: (sessionId: string, cwd?: string) => void | Promise<void>;
  onClose: () => void;
  onToast?: (message: string) => void;
}

const STATUS_LABELS: Partial<Record<SessionStatus, string>> = {
  pending: "未开始",
  planning: "规划中",
  working: "执行中",
  awaiting_permission: "等待授权",
  awaiting_answer: "等待回答",
  awaiting_approval: "等待批准",
  pausing: "正在暂停",
  paused: "已暂停",
  stopping: "正在停止",
  stopped: "已停止",
  completed: "本轮已结束",
  failed: "执行失败",
};

function formatRecentActivity(value?: string): string {
  if (!value) return "活动时间未知";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "活动时间未知";
  return `最近活动 ${new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date)}`;
}

/**
 * Canonical archive manager. Archive is persisted session content rather than
 * an application preference, but Settings > Data & Support is the predictable
 * low-frequency management surface used by ChatGPT-class clients.
 */
export function ArchivedSessionsSettingsPanel({
  onRestoreSession,
  onDeleteSession,
  onOpenSession,
  onClose,
  onToast,
}: ArchivedSessionsSettingsPanelProps) {
  const sessions = useSessionsStore((state) => state.independent);
  const projects = useProjectsStore((state) => state.projects);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<ArchiveScope>("all");
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());
  const [bulkRestoring, setBulkRestoring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { requestConfirmation, dialog } = useAppDialog("archived-session-settings");

  const projectContextBySession = useMemo(() => {
    const contexts = new Map<string, Pick<ArchivedSessionEntry, "projectId" | "projectName" | "relation">>();
    for (const project of projects) {
      for (const conversation of project.conversations) {
        contexts.set(conversation.sessionId, {
          projectId: project.id,
          projectName: project.name,
          relation: "项目对话",
        });
      }
      for (const plan of project.plans) {
        if (!plan.sessionId) continue;
        contexts.set(plan.sessionId, {
          projectId: project.id,
          projectName: project.name,
          relation: `计划：${plan.title}`,
        });
      }
      for (const task of project.tasks) {
        if (!task.sessionId) continue;
        contexts.set(task.sessionId, {
          projectId: project.id,
          projectName: project.name,
          relation: `任务：${task.title}`,
        });
      }
    }
    return contexts;
  }, [projects]);

  const archived = useMemo<ArchivedSessionEntry[]>(() => sessions
    .filter((session) => session.archived)
    .map((session) => ({
      sessionId: session.sessionId,
      title: session.title || "未命名会话",
      cwd: session.cwd,
      updatedAt: session.updatedAt,
      status: session.status,
      ...projectContextBySession.get(session.sessionId),
    }))
    .sort((a, b) => {
      const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      return bTime - aTime;
    }), [projectContextBySession, sessions]);

  const standaloneCount = archived.filter((entry) => !entry.projectId).length;
  const projectCount = archived.length - standaloneCount;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visible = archived.filter((entry) => {
    if (scope === "standalone" && entry.projectId) return false;
    if (scope === "project" && !entry.projectId) return false;
    if (!normalizedQuery) return true;
    return [entry.title, entry.projectName, entry.relation, entry.cwd]
      .some((value) => value?.toLocaleLowerCase().includes(normalizedQuery));
  });

  const markBusy = (sessionId: string, busy: boolean) => {
    setBusyIds((current) => {
      const next = new Set(current);
      if (busy) next.add(sessionId);
      else next.delete(sessionId);
      return next;
    });
  };

  const restore = async (entry: ArchivedSessionEntry, openAfterRestore: boolean) => {
    if (!onRestoreSession || busyIds.has(entry.sessionId) || bulkRestoring) return;
    setError(null);
    markBusy(entry.sessionId, true);
    try {
      await onRestoreSession(entry.sessionId, false, entry.cwd);
      if (openAfterRestore && onOpenSession) {
        onClose();
        await onOpenSession(entry.sessionId, entry.cwd);
      } else {
        onToast?.(`已恢复“${entry.title}”`);
      }
    } catch (cause) {
      const message = `恢复失败：${String(cause).replace(/^Error:\s*/, "")}`;
      setError(message);
      onToast?.(message);
    } finally {
      markBusy(entry.sessionId, false);
    }
  };

  const restoreAllVisible = () => {
    if (!onRestoreSession || visible.length === 0 || bulkRestoring) return;
    const snapshot = [...visible];
    requestConfirmation({
      title: `恢复当前 ${snapshot.length} 个归档会话？`,
      description: query || scope !== "all"
        ? "只恢复当前搜索和范围筛选结果，其他归档会话保持不变。"
        : "这些会话将重新出现在原来的任务或项目中。",
      confirmLabel: "全部恢复",
      action: async () => {
        setBulkRestoring(true);
        setError(null);
        const failures: string[] = [];
        try {
          for (const entry of snapshot) {
            try {
              await onRestoreSession(entry.sessionId, false, entry.cwd);
            } catch {
              failures.push(entry.title);
            }
          }
          if (failures.length > 0) {
            const message = `已恢复 ${snapshot.length - failures.length} 个，${failures.length} 个恢复失败`;
            setError(message);
            onToast?.(message);
          } else {
            onToast?.(`已恢复 ${snapshot.length} 个会话`);
          }
        } finally {
          setBulkRestoring(false);
        }
      },
    });
  };

  const requestDelete = (entry: ArchivedSessionEntry) => {
    if (!onDeleteSession || busyIds.has(entry.sessionId) || bulkRestoring) return;
    requestConfirmation({
      title: `永久删除对话“${entry.title}”？`,
      description: "对话历史与应用内关联信息将被删除且无法恢复；项目资产和工作区原始文件不会被删除。",
      confirmLabel: "永久删除",
      danger: true,
      action: async () => {
        markBusy(entry.sessionId, true);
        setError(null);
        try {
          await onDeleteSession(entry.sessionId, entry.cwd);
        } catch (cause) {
          const message = `删除失败：${String(cause).replace(/^Error:\s*/, "")}`;
          setError(message);
          onToast?.(message);
          throw cause;
        } finally {
          markBusy(entry.sessionId, false);
        }
      },
    });
  };

  return (
    <div className="settings-section archived-settings">
      <header className="settings-section__header archived-settings__header">
        <div className="settings-section__heading">
          <h2 className="settings-section__title">已归档</h2>
          <p className="settings-section__desc">归档只会收起会话，不会删除历史记录。可在这里恢复并继续任务。</p>
        </div>
        <button
          type="button"
          className="settings-btn"
          onClick={restoreAllVisible}
          disabled={!onRestoreSession || visible.length === 0 || bulkRestoring}
        >
          {bulkRestoring ? <Loader2 size={15} className="archive-spin" /> : <ArchiveRestore size={15} />}
          {bulkRestoring ? "恢复中…" : `恢复当前 ${visible.length} 项`}
        </button>
      </header>

      <div className="archived-settings__toolbar">
        <label className="archived-settings__search">
          <Search size={16} aria-hidden="true" />
          <input
            type="search"
            aria-label="搜索已归档会话"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索标题、项目或工作目录"
          />
        </label>
        <div className="archived-settings__scopes" role="group" aria-label="归档范围">
          {([
            ["all", `全部 ${archived.length}`],
            ["standalone", `独立任务 ${standaloneCount}`],
            ["project", `项目 ${projectCount}`],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={scope === value}
              className={scope === value ? "archived-settings__scope archived-settings__scope--active" : "archived-settings__scope"}
              onClick={() => setScope(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="archived-settings__error" role="alert">{error}</div>}

      {archived.length === 0 ? (
        <div className="archived-settings__empty">
          <ArchiveRestore size={34} aria-hidden="true" />
          <strong>暂无已归档会话</strong>
          <span>从会话的“…”菜单选择“归档”后，会显示在这里。</span>
        </div>
      ) : visible.length === 0 ? (
        <div className="archived-settings__empty">
          <Search size={32} aria-hidden="true" />
          <strong>没有匹配的归档会话</strong>
          <span>尝试更换关键词或范围。</span>
        </div>
      ) : (
        <ul className="archived-settings__list" aria-label="已归档会话列表">
          {visible.map((entry) => {
            const busy = busyIds.has(entry.sessionId);
            return (
              <li className="archived-settings__item" key={entry.sessionId}>
                <div className="archived-settings__item-icon" aria-hidden="true">
                  {entry.projectId ? <FolderKanban size={18} /> : <MessageSquare size={18} />}
                </div>
                <div className="archived-settings__item-content">
                  <strong className="archived-settings__item-title" title={entry.title}>{entry.title}</strong>
                  <span className="archived-settings__item-meta">
                    {entry.projectName ? `${entry.projectName} · ${entry.relation}` : "独立任务"}
                    {entry.status ? ` · ${STATUS_LABELS[entry.status] ?? entry.status}` : ""}
                  </span>
                  <span className="archived-settings__item-time">{formatRecentActivity(entry.updatedAt)}</span>
                </div>
                <div className="archived-settings__item-actions">
                  <button
                    type="button"
                    className="settings-btn settings-btn--primary"
                    onClick={() => void restore(entry, true)}
                    disabled={busy || bulkRestoring || !onRestoreSession || !onOpenSession}
                  >
                    {busy ? <Loader2 size={14} className="archive-spin" /> : <ArchiveRestore size={14} />}
                    恢复并打开
                  </button>
                  <button
                    type="button"
                    className="settings-btn"
                    onClick={() => void restore(entry, false)}
                    disabled={busy || bulkRestoring || !onRestoreSession}
                  >
                    仅恢复
                  </button>
                  <button
                    type="button"
                    className="archived-settings__delete"
                    aria-label={`永久删除 ${entry.title}`}
                    title="永久删除"
                    onClick={() => requestDelete(entry)}
                    disabled={busy || bulkRestoring || !onDeleteSession}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {dialog}
    </div>
  );
}
