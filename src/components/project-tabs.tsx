/**
 * 项目详情页四个 tab 面板 — 对齐目标截图，数据来自本地 store。
 *
 *  - 动态: 真实项目会话与资源统计
 *  - 计划/任务: 持久化看板与列表，支持新建、流转和删除
 *  - 资产: 从用户选择的文件复制到项目私有目录，支持打开、新建目录和删除
 */
import { useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useProjectsStore, PLAN_COLUMNS, type PlanStatus, type AssetItem } from "@/stores/projects-store";
import { openLocalPath, projectAssetMakeDir, projectAssetRemove, projectAssetsImport } from "@/lib/agent-client";
import { formatFileSize } from "@/lib/file-utils";

// ============================================================
// 动态
// ============================================================

export function ActivityTab({ projectId }: { projectId: string }) {
  const project = useProjectsStore((s) => s.projects.find((p) => p.id === projectId));
  const conversations = project?.conversations ?? [];
  return (
    <div className="pd-tab">
      <div className="pd-activity-switch" aria-label="项目概览">
        <span className="pd-pill pd-pill--on">{conversations.length} 个对话</span>
        <span className="pd-pill">{project?.plans.length ?? 0} 项计划</span>
        <span className="pd-pill">{project?.tasks.length ?? 0} 项任务</span>
        <span className="pd-pill">{project?.assets.length ?? 0} 个资产</span>
      </div>
      {conversations.length === 0 ? (
        <div className="pd-empty">暂无真实运行记录，从下方输入框启动第一个项目对话。</div>
      ) : (
        <ul className="pd-task-list" aria-label="最近项目对话">
          {conversations.slice(0, 20).map((conversation) => (
            <li className="pd-task-item" key={conversation.sessionId}>
              <span className="pd-task-item__title">{conversation.title}</span>
              <span className="pd-task-item__meta">对话 · {relTime(conversation.createdAt)}</span>
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

export function PlanTab({ projectId }: { projectId: string }) {
  const plans = useProjectsStore((s) => s.projects.find((p) => p.id === projectId)?.plans ?? []);
  const addPlan = useProjectsStore((s) => s.addPlan);
  const movePlan = useProjectsStore((s) => s.movePlan);
  const removePlan = useProjectsStore((s) => s.removePlan);

  const newTodo = () => {
    const title = window.prompt("新建待办标题");
    if (title && title.trim()) addPlan(projectId, title.trim(), "pending");
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
                  onClick={() => {
                    const title = window.prompt(`在「${col.label}」新建待办`);
                    if (title && title.trim()) addPlan(projectId, title.trim(), col.status);
                  }}
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
                        <button className="pd-board-card__del" aria-label="删除" onClick={() => removePlan(projectId, c.id)}>×</button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================
// 任务
// ============================================================

export function TaskTab({ projectId }: { projectId: string }) {
  const tasks = useProjectsStore((s) => s.projects.find((p) => p.id === projectId)?.tasks ?? []);
  const addTask = useProjectsStore((s) => s.addTask);
  const removeTask = useProjectsStore((s) => s.removeTask);
  const [q, setQ] = useState("");

  const filtered = tasks.filter((t) => t.title.toLowerCase().includes(q.toLowerCase()));

  const newTask = () => {
    const title = window.prompt("新建任务标题");
    if (title && title.trim()) addTask(projectId, title.trim());
  };

  return (
    <div className="pd-tab">
      <div className="pd-toolbar">
        <div className="pd-toolbar__left">
          <span className="pd-toolbar__hint">项目任务保存在本机 EchoAgent 私有数据目录</span>
        </div>
        <div className="pd-toolbar__right">
          <input className="pd-search-inline" placeholder="搜索任务标题" value={q} onChange={(e) => setQ(e.target.value)} />
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
              <span className="pd-task-item__meta">{t.scope === "personal" ? "个人" : "共享"} · {t.source}</span>
              <button className="pd-task-item__del" aria-label="删除" onClick={() => removeTask(projectId, t.id)}>×</button>
            </li>
          ))}
        </ul>
      )}
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
  const removeAsset = useProjectsStore((s) => s.removeAsset);
  const [q, setQ] = useState("");

  const used = useMemo(() => usedBytes(assets), [assets]);

  const newFolder = async () => {
    const name = window.prompt("文件夹名称");
    if (!name?.trim()) return;
    try {
      const asset = await projectAssetMakeDir(projectId, name.trim());
      addAsset(projectId, asset);
      onToast?.("文件夹已创建");
    } catch (error) {
      onToast?.(`创建失败：${String(error).replace(/^Error:\s*/, "")}`);
    }
  };
  const upload = async () => {
    try {
      const selected = await openDialog({ multiple: true, directory: false });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      const imported = await projectAssetsImport(projectId, paths);
      imported.forEach((asset) => addAsset(projectId, asset));
      onToast?.(`已导入 ${imported.length} 个文件（原文件未修改）`);
    } catch (error) {
      onToast?.(`导入失败：${String(error).replace(/^Error:\s*/, "")}`);
    }
  };

  const remove = async (asset: AssetItem) => {
    if (!window.confirm(`确定删除资产「${asset.name}」？`)) return;
    try {
      if (asset.path) await projectAssetRemove(projectId, asset.path);
      removeAsset(projectId, asset.id);
      onToast?.(asset.path ? "资产副本已删除" : "旧版资产元数据已删除");
    } catch (error) {
      onToast?.(`删除失败：${String(error).replace(/^Error:\s*/, "")}`);
    }
  };

  const rows = assets.filter((a) => a.name.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="pd-tab">
      <div className="pd-toolbar">
        <div className="pd-toolbar__left">
          <button className="pd-btn" onClick={newFolder}>新建文件夹</button>
          <button className="pd-btn" onClick={upload}>导入文件副本</button>
          <span className="pd-toolbar__hint">
            本地项目资产已用 {formatFileSize(used)}
          </span>
        </div>
        <div className="pd-toolbar__right">
          <input className="pd-search-inline" placeholder="搜索文件或文件夹…" value={q} onChange={(e) => setQ(e.target.value)} />
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
              <td className="pd-asset-empty" colSpan={6}>暂无资产，点击「上传文件」或「新建文件夹」开始。</td>
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
                  <button className="pd-asset-del" aria-label="删除" onClick={() => void remove(a)}>×</button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
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
