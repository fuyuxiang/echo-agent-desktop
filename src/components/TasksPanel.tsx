/**
 * 运行中任务面板 - 显示 EchoAgent 的后台任务和子代理
 *
 * EchoAgent 通过工具调用启动的 background tasks 和 spawn_subagent 在后台运行。
 * 这里通过 `echo.agent/task/list` + `echo.agent/subagent/list_running` 观测它们，
 * 通过 `echo.agent/task/kill` / `echo.agent/subagent/cancel` 取消。
 *
 * 这个面板嵌入到 ChatView 右侧或作为浮层。监听 `agent://task-update` 自动刷新。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  TaskListIcon,
  DeleteIcon,
  RefreshCwIcon,
  CheckIcon,
} from "@/foundation/components/Icon/icons";
import { taskKill, tasksList } from "@/lib/agent-client";
import type { RunningTask } from "@/lib/types";

interface TasksPanelProps {
  /** Optional: listen for task update events to auto-refresh. Set to a counter
   *  that increments on each `agent://task-update`. */
  refreshSignal?: number;
  onToast?: (msg: string) => void;
}

export function TasksPanel({ refreshSignal, onToast }: TasksPanelProps) {
  const [tasks, setTasks] = useState<RunningTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reloadGenerationRef = useRef(0);

  const reload = useCallback(async () => {
    const generation = ++reloadGenerationRef.current;
    setLoading(true);
    try {
      const nextTasks = await tasksList();
      if (reloadGenerationRef.current !== generation) return;
      setTasks(nextTasks);
      setError(null);
    } catch (cause) {
      if (reloadGenerationRef.current !== generation) return;
      // Keep the last known tasks visible so a transient list failure never
      // removes the user's only way to terminate background work.
      setError(String(cause).replace(/^Error:\s*/, ""));
    } finally {
      if (reloadGenerationRef.current === generation) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    return () => {
      reloadGenerationRef.current += 1;
    };
  }, [reload, refreshSignal]);

  const handleKill = useCallback(
    async (taskId: string) => {
      try {
        await taskKill(taskId);
        onToast?.("已终止任务");
        reload();
      } catch (e) {
        onToast?.(`终止失败：${String(e).replace(/^Error:\s*/, "")}`);
      }
    },
    [onToast, reload],
  );

  if (tasks.length === 0 && !loading && !error) {
    return null; // Hide entirely when empty — panel only shows when there's work.
  }

  return (
    <div className="tasks-panel">
      <div className="tasks-panel__header">
        <h3 className="tasks-panel__title">
          <TaskListIcon size="sm" /> 运行中任务 ({tasks.length})
        </h3>
        <button
          className="tasks-panel__refresh"
          onClick={reload}
          disabled={loading}
          title="刷新"
          aria-label={error ? "重试加载运行中任务" : "刷新运行中任务"}
        >
          <RefreshCwIcon size="sm" />
        </button>
      </div>
      {error && (
        <div className="tasks-panel__loading" role="alert">
          加载运行中任务失败：{error}。已保留上次结果，请重试。
        </div>
      )}
      <ul className="tasks-panel__list">
        {tasks.map((task) => (
          <li key={task.id} className="tasks-panel__item">
            <div className="tasks-panel__item-icon">
              {task.status === "completed" ? (
                <CheckIcon size="sm" />
              ) : (
                <TaskListIcon size="sm" />
              )}
            </div>
            <div className="tasks-panel__item-body">
              <div className="tasks-panel__item-desc">
                {task.description ?? task.id}
              </div>
              <div className="tasks-panel__item-meta">
                {task.kind && <span>{task.kind}</span>}
                {task.status && <span>· {task.status}</span>}
                <span className="tasks-panel__item-id">#{task.id.slice(0, 8)}</span>
              </div>
            </div>
            <button
              className="tasks-panel__kill"
              onClick={() => handleKill(task.id)}
              title="终止"
            >
              <DeleteIcon size="sm" />
            </button>
          </li>
        ))}
        {loading && <li className="tasks-panel__loading">加载中…</li>}
      </ul>
    </div>
  );
}
