/**
 * 项目详情页四个 tab 面板 — 对齐目标截图，数据来自本地 store。
 *
 *  - 动态: 真实项目会话与资源统计
 *  - 计划/任务: 持久化看板与列表，支持新建、流转和删除
 *  - 资产: 从用户选择的文件复制到项目私有目录，支持打开、新建目录和删除
 */
import { useMemo, useState } from "react";
import { useProjectsStore, PLAN_COLUMNS, type PlanStatus, type AssetItem } from "@/stores/projects-store";
import { filesystemPickFiles, openLocalPath, projectAssetMakeDir, projectAssetRemove, projectAssetsImport } from "@/lib/agent-client";
import { formatFileSize } from "@/lib/file-utils";
import { useAppDialog } from "./AppDialog";

// ============================================================
// 动态
// ============================================================

export function ActivityTab({
  projectId,
  onOpenSession,
}: {
  projectId: string;
  onOpenSession?: (sessionId: string, cwd?: string) => void;
}) {
  const project = useProjectsStore((s) => s.projects.find((p) => p.id === projectId));
  const conversations = (project?.conversations ?? []).filter((conversation) => !conversation.archived);
  const archivedCount = (project?.conversations ?? []).length - conversations.length;
  return (
    <div className="pd-tab">
      <div className="pd-activity-switch" aria-label="项目概览">
        <span className="pd-pill pd-pill--on">{conversations.length} 个对话</span>
        {archivedCount > 0 && <span className="pd-pill">{archivedCount} 个已归档</span>}
        <span className="pd-pill">{project?.plans.length ?? 0} 项计划</span>
        <span className="pd-pill">{project?.tasks.length ?? 0} 项任务</span>
        <span className="pd-pill">{project?.assets.length ?? 0} 个资产</span>
      </div>
      {conversations.length === 0 ? (
        <div className="pd-empty">
          {archivedCount > 0
            ? "所有项目对话均已归档，可在侧栏的归档筛选中恢复。"
            : "暂无真实运行记录，从下方输入框启动第一个项目对话。"}
        </div>
      ) : (
        <ul className="pd-task-list" aria-label="最近项目对话">
          {conversations.slice(0, 20).map((conversation) => (
            <li key={conversation.sessionId}>
              <button
                type="button"
                className={`pd-task-item${onOpenSession ? " pd-task-item--clickable" : ""}`}
                style={{ width: "100%", textAlign: "left" }}
                onClick={() => onOpenSession?.(conversation.sessionId, project?.cwd)}
                disabled={!onOpenSession}
              >
                <span className="pd-task-item__title">{conversation.title}</span>
                <span className="pd-task-item__meta">对话 · {relTime(conversation.createdAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ============================================================
// 计划（看板）
// ============================================================

const COL_DOT: Record<PlanStatus, string> = {
  pending: "#bbb",
  in_progress: "#18a058",
  paused: "#f0a020",
  completed: "#18a058",
};

export function PlanTab({
  projectId,
  onRun,
  onOpenSession,
}: {
  projectId: string;
  onRun?: (message: string) => Promise<string | undefined>;
  onOpenSession?: (sessionId: string) => void;
}) {
  const plans = useProjectsStore((s) => s.projects.find((p) => p.id === projectId)?.plans ?? []);
  const addPlan = useProjectsStore((s) => s.addPlan);
  const movePlan = useProjectsStore((s) => s.movePlan);
  const linkPlanSession = useProjectsStore((s) => s.linkPlanSession);
  const removePlan = useProjectsStore((s) => s.removePlan);
  const { requestConfirmation, requestInput, dialog } = useAppDialog(projectId);

  const newTodo = () => {
    requestInput({
      title: "新建待办",
      fields: [{ name: "title", label: "待办标题", required: true, maxLength: 200 }],
      confirmLabel: "创建",
      action: ({ title }) => addPlan(projectId, title.trim(), "pending"),
    });
  };

  const newTodoInColumn = (status: PlanStatus, label: string) => {
    requestInput({
      title: `在“${label}”新建待办`,
      fields: [{ name: "title", label: "待办标题", required: true, maxLength: 200 }],
      confirmLabel: "创建",
      action: ({ title }) => addPlan(projectId, title.trim(), status),
    });
  };

  const requestRemovePlan = (card: (typeof plans)[number]) => {
    requestConfirmation({
      title: `删除待办“${card.title}”？`,
      description: "该待办及其关联信息将从项目中删除。",
      confirmLabel: "删除待办",
      danger: true,
      action: () => removePlan(projectId, card.id),
    });
  };

  const runWithAgent = async (card: { id: string; title: string; status: PlanStatus }) => {
    if (!onRun) return;
    const previous = card.status;
    movePlan(projectId, card.id, "in_progress");
    try {
      const sessionId = await onRun(`请执行项目计划项「${card.title}」。先确认完成标准，再实施并汇报产出。`);
      if (sessionId) linkPlanSession(projectId, card.id, sessionId);
      else movePlan(projectId, card.id, previous);
    } catch {
      movePlan(projectId, card.id, previous);
    }
  };

  return (
    <div className="pd-tab">
      <div className="pd-toolbar">
        <div className="pd-toolbar__left">
          <button className="pd-btn pd-btn--primary" onClick={newTodo}>+ 新建待办</button>
        </div>
      </div>

      <div className="pd-board">
        {PLAN_COLUMNS.map((col) => {
          const cards = plans.filter((c) => c.status === col.status);
          return (
            <div className="pd-board-col" key={col.status}>
              <div className="pd-board-col__head">
                <span className="pd-board-col__dot" style={{ background: COL_DOT[col.status] }} />
                <span className="pd-board-col__label">{col.label}</span>
                <span className="pd-board-col__count">{cards.length}</span>
                <button
                  className="pd-board-col__add"
                  aria-label={`在${col.label}新建`}
                  onClick={() => newTodoInColumn(col.status, col.label)}
                >
                  +
                </button>
              </div>
              <div className="pd-board-col__body">
                {cards.length === 0 ? (
                  <div className="pd-board-empty">
                    {col.status === "pending" ? "暂无事项，可从这里开始新建。" : "暂无事项"}
                  </div>
                ) : (
                  cards.map((c) => (
                    <div className="pd-board-card" key={c.id}>
                      <span className="pd-board-card__title">{c.title}</span>
                      <div className="pd-board-card__acts">
                        {onRun && c.status !== "completed" && (
                          <button className="pd-board-card__run" onClick={() => void runWithAgent(c)}>
                            交给 Agent
                          </button>
                        )}
                        {c.sessionId && onOpenSession && (
                          <button
                            className="pd-board-card__move"
                            onClick={() => onOpenSession(c.sessionId!)}
                            disabled={c.sessionArchived}
                            title={c.sessionArchived ? "该会话已归档，请先在侧栏的归档筛选中恢复" : undefined}
                          >
                            {c.sessionArchived ? "会话已归档" : "打开会话"}
                          </button>
                        )}
                        {PLAN_COLUMNS.filter((x) => x.status !== c.status).map((x) => (
                          <button
                            key={x.status}
                            className="pd-board-card__move"
                            title={`移到${x.label}`}
                            onClick={() => movePlan(projectId, c.id, x.status)}
                          >
                            →{x.label}
                          </button>
                        ))}
                        <button className="pd-board-card__del" aria-label={`删除待办 ${c.title}`} onClick={() => requestRemovePlan(c)}>×</button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>
      {dialog}
    </div>
  );
}

// ============================================================
// 任务
// ============================================================

export function TaskTab({
  projectId,
  onRun,
  onOpenSession,
}: {
  projectId: string;
  onRun?: (message: string) => Promise<string | undefined>;
  onOpenSession?: (sessionId: string) => void;
}) {
  const tasks = useProjectsStore((s) => s.projects.find((p) => p.id === projectId)?.tasks ?? []);
  const addTask = useProjectsStore((s) => s.addTask);
  const moveTask = useProjectsStore((s) => s.moveTask);
  const linkTaskSession = useProjectsStore((s) => s.linkTaskSession);
  const removeTask = useProjectsStore((s) => s.removeTask);
  const [q, setQ] = useState("");
  const { requestConfirmation, requestInput, dialog } = useAppDialog(projectId);

  const filtered = tasks.filter((t) => t.title.toLowerCase().includes(q.toLowerCase()));

  const newTask = () => {
    requestInput({
      title: "新建任务",
      fields: [{ name: "title", label: "任务标题", required: true, maxLength: 200 }],
      confirmLabel: "创建",
      action: ({ title }) => addTask(projectId, title.trim()),
    });
  };

  const requestRemoveTask = (task: (typeof tasks)[number]) => {
    requestConfirmation({
      title: `删除任务“${task.title}”？`,
      description: "该任务及其关联信息将从项目中删除。",
      confirmLabel: "删除任务",
      danger: true,
      action: () => removeTask(projectId, task.id),
    });
  };

  const runWithAgent = async (task: (typeof tasks)[number]) => {
    if (!onRun) return;
    const previous = task.status;
    moveTask(projectId, task.id, "in_progress");
    try {
      const sessionId = await onRun(`请执行项目任务「${task.title}」。请直接产出可验收结果，如有阻塞请明确说明。`);
      if (sessionId) linkTaskSession(projectId, task.id, sessionId);
      else moveTask(projectId, task.id, previous);
    } catch {
      moveTask(projectId, task.id, previous);
    }
  };

  return (
    <div className="pd-tab">
      <div className="pd-toolbar">
        <div className="pd-toolbar__left">
          <span className="pd-toolbar__hint">项目任务保存在本机 EchoAgent 私有数据目录</span>
        </div>
        <div className="pd-toolbar__right">
          <input className="pd-search-inline" aria-label="搜索任务标题" placeholder="搜索任务标题" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="pd-btn pd-btn--primary" onClick={newTask}>+ 新建任务</button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="pd-empty">{q ? "没有符合条件的任务" : "暂无任务，点击「新建任务」开始。"}</div>
      ) : (
        <ul className="pd-task-list">
          {filtered.map((t) => (
            <li className="pd-task-item" key={t.id}>
              <span className="pd-task-item__title">{t.title}</span>
              <span className="pd-task-item__meta">
                {PLAN_COLUMNS.find((column) => column.status === t.status)?.label ?? "待开始"}
                {t.sessionId ? " · 已关联 Agent 会话" : ""}
              </span>
              <div className="pd-task-item__actions">
                {onRun && t.status !== "completed" && (
                  <button className="pd-btn pd-btn--small" onClick={() => void runWithAgent(t)}>交给 Agent</button>
                )}
                {t.sessionId && onOpenSession && (
                  <button
                    className="pd-btn pd-btn--small"
                    onClick={() => onOpenSession(t.sessionId!)}
                    disabled={t.sessionArchived}
                    title={t.sessionArchived ? "该会话已归档，请先在侧栏的归档筛选中恢复" : undefined}
                  >
                    {t.sessionArchived ? "会话已归档" : "打开会话"}
                  </button>
                )}
                <select
                  aria-label={`调整任务状态 ${t.title}`}
                  value={t.status}
                  onChange={(event) => moveTask(projectId, t.id, event.target.value as PlanStatus)}
                >
                  {PLAN_COLUMNS.map((column) => <option key={column.status} value={column.status}>{column.label}</option>)}
                </select>
              </div>
              <button className="pd-task-item__del" aria-label={`删除任务 ${t.title}`} onClick={() => requestRemoveTask(t)}>×</button>
            </li>
          ))}
        </ul>
      )}
      {dialog}
    </div>
  );
}

// ============================================================
// 资产
// ============================================================

function usedBytes(assets: AssetItem[]): number {
  return assets.reduce((sum, asset) => sum + (asset.sizeBytes ?? 0), 0);
}

export function AssetsTab({ projectId, onToast }: { projectId: string; onToast?: (message: string) => void }) {
  const assets = useProjectsStore((s) => s.projects.find((p) => p.id === projectId)?.assets ?? []);
  const addAsset = useProjectsStore((s) => s.addAsset);
  const addAssets = useProjectsStore((s) => s.addAssets);
  const removeAsset = useProjectsStore((s) => s.removeAsset);
  const [q, setQ] = useState("");
  const [uploading, setUploading] = useState(false);
  const { requestConfirmation, requestInput, dialog } = useAppDialog(projectId);

  const used = useMemo(() => usedBytes(assets), [assets]);

  const newFolder = () => {
    requestInput({
      title: "新建项目文件夹",
      description: "文件夹将创建在项目的私有资产目录中。",
      fields: [{ name: "name", label: "文件夹名称", required: true, maxLength: 255 }],
      validate: ({ name }) => validateAssetName(name),
      confirmLabel: "创建",
      action: async ({ name }) => {
        const asset = await projectAssetMakeDir(projectId, name.trim());
        addAsset(projectId, asset);
        onToast?.("文件夹已创建");
      },
      onError: (error) => onToast?.(`创建失败：${String(error).replace(/^Error:\s*/, "")}`),
    });
  };
  const upload = async () => {
    if (uploading) return;
    try {
      setUploading(true);
      const paths = await filesystemPickFiles({ title: "选择要导入项目的文件" });
      if (paths.length === 0) return;
      const imported = await projectAssetsImport(projectId, paths);
      addAssets(projectId, imported);
      onToast?.(`已导入 ${imported.length} 个文件（原文件未修改）`);
    } catch (error) {
      onToast?.(`导入失败：${String(error).replace(/^Error:\s*/, "")}`);
    } finally {
      setUploading(false);
    }
  };

  const remove = (asset: AssetItem) => {
    requestConfirmation({
      title: `删除资产“${asset.name}”？`,
      description: asset.path
        ? "项目私有目录中的副本将被永久删除，原始导入文件不受影响。"
        : "该旧版资产元数据将从项目中删除。",
      confirmLabel: "删除资产",
      danger: true,
      action: async () => {
        if (asset.path) await projectAssetRemove(projectId, asset.path);
        removeAsset(projectId, asset.id);
        onToast?.(asset.path ? "资产副本已删除" : "旧版资产元数据已删除");
      },
      onError: (error) => onToast?.(`删除失败：${String(error).replace(/^Error:\s*/, "")}`),
    });
  };

  const rows = assets.filter((a) => a.name.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="pd-tab">
      <div className="pd-toolbar">
        <div className="pd-toolbar__left">
          <button className="pd-btn" onClick={newFolder}>新建文件夹</button>
          <button className="pd-btn" onClick={() => void upload()} disabled={uploading}>
            {uploading ? "导入中…" : "导入文件副本"}
          </button>
          <span className="pd-toolbar__hint">
            本地项目资产已用 {formatFileSize(used)}
          </span>
        </div>
        <div className="pd-toolbar__right">
          <input className="pd-search-inline" aria-label="搜索项目资产" placeholder="搜索文件或文件夹…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>

      <table className="pd-asset-table">
        <thead>
          <tr>
            <th className="pd-asset-table__name">名称</th>
            <th>类型</th>
            <th>更新人</th>
            <th>更新时间</th>
            <th>大小</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td className="pd-asset-empty" colSpan={6}>暂无资产，点击「导入文件副本」或「新建文件夹」开始。</td>
            </tr>
          ) : (
            rows.map((a) => (
              <tr key={a.id}>
                <td className="pd-asset-table__name">
                  <button
                    type="button"
                    className="pd-asset-open"
                    disabled={!a.path}
                    title={a.path ? "用系统默认应用打开" : "旧版元数据没有对应文件"}
                    onClick={() => a.path && void openLocalPath(a.path).catch((error) => onToast?.(`打开失败：${String(error)}`))}
                  >
                  <span className="pd-asset-icon">{a.kind === "folder" ? "📁" : "📄"}</span>
                  {a.name}
                  </button>
                </td>
                <td>{a.kind === "folder" ? "文件夹" : a.ext ?? "文件"}</td>
                <td>{a.updater ?? "-"}</td>
                <td>{a.updatedAt ? relTime(a.updatedAt) : "-"}</td>
                <td>{a.kind === "folder" ? "-" : a.sizeBytes !== undefined ? formatFileSize(a.sizeBytes) : a.sizeLabel ?? "-"}</td>
                <td>
                  <button className="pd-asset-del" aria-label={`删除资产 ${a.name}`} onClick={() => void remove(a)}>×</button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      {dialog}
    </div>
  );
}

function validateAssetName(value: string): string | null {
  const name = value.trim();
  if (!name) return "文件夹名称不能为空。";
  if (name === "." || name === ".." || /[\\/\u0000-\u001f\u007f]/.test(name)) {
    return "文件夹名称不能包含路径分隔符或控制字符，也不能是 . 或 ..。";
  }
  return null;
}

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m}分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}小时前`;
  return `${Math.floor(h / 24)}天前`;
}
