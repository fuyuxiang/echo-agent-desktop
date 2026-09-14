import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";

import { describePhase, isBusyPhase } from "../lib/phase";
import type { TaskSummary } from "../lib/types";

interface TaskSwitcherProps {
  tasks: TaskSummary[];
  activeId?: string | null;
  onSelect: (taskId: string) => void;
  onNew: () => void;
  onRename: (task: TaskSummary, returnFocus?: HTMLElement | null) => void;
  onDelete: (task: TaskSummary, returnFocus?: HTMLElement | null) => void;
}

/**
 * Current task plus a menu of the workspace's other tasks.
 *
 * A repository can hold several tasks at once, so the workbench needs an explicit
 * switcher; without it a new task would silently replace the previous one's
 * state, which is what the old implementation did.
 */
export function TaskSwitcher({
  tasks,
  activeId,
  onSelect,
  onNew,
  onRename,
  onDelete,
}: TaskSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [actionTaskId, setActionTaskId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setActionTaskId(null);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        setActionTaskId(null);
        toggleRef.current?.focus();
      }
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const active = tasks.find((task) => task.id === activeId);

  return (
    <div className={`coding-task-switcher${active ? "" : " is-empty"}`} ref={containerRef}>
      <button
        ref={toggleRef}
        type="button"
        onClick={() => {
          setOpen((value) => !value);
          setActionTaskId(null);
        }}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="切换开发任务"
      >
        {!active && <Plus size={12} />}
        <span>{active ? active.name : "新建任务"}</span>
        <ChevronDown size={12} />
      </button>

      {open && (
        <div className="coding-task-switcher__menu" role="menu">
          {tasks.length === 0 && <div className="coding-row">当前仓库还没有开发任务</div>}
          {tasks.map((task) => {
            const phase = describePhase(task.phase);
            const actionsOpen = actionTaskId === task.id;
            return (
              <div className="coding-task-switcher__entry" key={task.id} role="none">
                <div className={`coding-task-switcher__row${task.id === activeId ? " is-active" : ""}`}>
                  <button
                    type="button"
                    role="menuitem"
                    className="coding-task-switcher__select"
                    aria-label={`打开任务：${task.name}，${phase.label}`}
                    aria-current={task.id === activeId ? "true" : undefined}
                    onClick={() => {
                      setOpen(false);
                      setActionTaskId(null);
                      onSelect(task.id);
                    }}
                  >
                    {phase.active ? (
                      <LoaderCircle size={12} className="is-spinning" />
                    ) : task.phase === "delivered" ? (
                      <CheckCircle2 size={12} />
                    ) : task.phase === "blocked" ? (
                      <AlertTriangle size={12} />
                    ) : (
                      <CircleDot size={12} />
                    )}
                    <span>{task.name}</span>
                    <small>{phase.label}</small>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="coding-task-switcher__more"
                    aria-label={`管理任务：${task.name}`}
                    aria-haspopup="menu"
                    aria-expanded={actionsOpen}
                    onClick={() => setActionTaskId((current) => current === task.id ? null : task.id)}
                  >
                    <MoreHorizontal size={13} />
                  </button>
                </div>
                {actionsOpen && (
                  <div className="coding-task-switcher__actions" role="menu" aria-label={`${task.name} 任务操作`}>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setOpen(false);
                        setActionTaskId(null);
                        onRename(task, toggleRef.current);
                      }}
                    >
                      <Pencil size={12} />
                      <span>重命名</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="is-danger"
                      disabled={isBusyPhase(task.phase)}
                      title={isBusyPhase(task.phase) ? "请先停止任务再删除" : "删除开发任务"}
                      onClick={() => {
                        setOpen(false);
                        setActionTaskId(null);
                        onDelete(task, toggleRef.current);
                      }}
                    >
                      <Trash2 size={12} />
                      <span>{isBusyPhase(task.phase) ? "执行中不可删除" : "删除任务"}</span>
                    </button>
                  </div>
                )}
              </div>
            );
          })}
          <div className="coding-task-switcher__sep" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onNew();
            }}
          >
            <Plus size={12} />
            <span>新建开发任务</span>
          </button>
        </div>
      )}
    </div>
  );
}
