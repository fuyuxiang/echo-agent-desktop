import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, CircleDot, LoaderCircle, Plus } from "lucide-react";

import { describePhase } from "../lib/phase";
import type { TaskSummary } from "../lib/types";

interface TaskSwitcherProps {
  tasks: TaskSummary[];
  activeId?: string | null;
  onSelect: (taskId: string) => void;
  onNew: () => void;
}

/**
 * Current task plus a menu of the workspace's other tasks.
 *
 * A repository can hold several tasks at once, so the workbench needs an explicit
 * switcher; without it a new task would silently replace the previous one's
 * state, which is what the old implementation did.
 */
export function TaskSwitcher({ tasks, activeId, onSelect, onNew }: TaskSwitcherProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
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
    <div className="coding-task-switcher" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="切换开发任务"
      >
        <span>{active ? active.name : "未开始任务"}</span>
        <ChevronDown size={12} />
      </button>

      {open && (
        <div className="coding-task-switcher__menu" role="menu">
          {tasks.length === 0 && <div className="coding-row">当前仓库还没有开发任务</div>}
          {tasks.map((task) => {
            const phase = describePhase(task.phase);
            return (
              <button
                key={task.id}
                type="button"
                role="menuitem"
                className={task.id === activeId ? "is-active" : ""}
                onClick={() => {
                  setOpen(false);
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
