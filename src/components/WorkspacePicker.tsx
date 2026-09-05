import { useEffect, useRef, useState } from "react";
import { ChevronDown, Check, Folder, FolderOpen } from "lucide-react";
import { filesystemPickDirectory, type WorkspaceInfo } from "@/lib/agent-client";

/**
 * Working-directory picker for the Composer.
 * Lists every cwd EchoAgent has seen (from list_workspaces). Selecting one
 * calls onSelectWorkspace — switching cwd means the next new session will
 * be bound to it (ACP locks cwd per-session, so we don't migrate the
 * current session).
 */
export function WorkspacePicker({
  cwd,
  workspaces,
  onSelectWorkspace,
}: {
  /** Currently active cwd (highlighted in the list). */
  cwd?: string;
  workspaces: WorkspaceInfo[];
  onSelectWorkspace: (cwd: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);

  const close = (restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const selected = menuRef.current?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]');
    (selected ?? menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]'))?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLUListElement>) => {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]') ?? [],
    );
    const index = items.indexOf(document.activeElement as HTMLElement);
    const focusAt = (nextIndex: number) => {
      if (items.length === 0) return;
      items[(nextIndex + items.length) % items.length]?.focus();
    };
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusAt(index + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusAt(index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusAt(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusAt(items.length - 1);
    }
  };

  // Shorten a cwd for display: show last 2 path segments.
  const shortName = (p: string) => {
    const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
    return parts.slice(-2).join("/") || p;
  };

  const triggerLabel = cwd ? shortName(cwd) : "选择工作目录";

  // 打开系统目录选择框，切换到任意文件夹（不限于历史目录）。
  const pickFolder = async () => {
    try {
      const selected = await filesystemPickDirectory();
      if (!selected) return;
      onSelectWorkspace(selected);
      close();
    } catch {
      // dialog plugin not available in non-Tauri env (vitest) — no-op.
    }
  };

  return (
    <div className="workspace-picker" ref={ref}>
      <button
        className="workspace-picker__trigger"
        onClick={() => setOpen((o) => !o)}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? "composer-workspace-menu" : undefined}
        ref={triggerRef}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <Folder size={14} strokeWidth={1.75} style={{ marginRight: 6 }} />
        <span className="workspace-picker__label">{triggerLabel}</span>
        <ChevronDown size={14} strokeWidth={1.75} className="workspace-picker__arrow" />
      </button>
      {open && (
        <ul
          className="workspace-picker__menu"
          id="composer-workspace-menu"
          role="menu"
          aria-label="选择工作目录"
          ref={menuRef}
          onKeyDown={handleMenuKeyDown}
        >
          <li role="none">
            <button
              type="button"
              className="workspace-picker__item workspace-picker__item--browse"
              onClick={pickFolder}
              role="menuitem"
            >
              <FolderOpen size={14} />
              <span className="workspace-picker__item-name">选择文件夹…</span>
            </button>
          </li>
          {workspaces.length === 0 && (
            <li className="workspace-picker__empty">暂无历史工作目录</li>
          )}
          {workspaces.map((w) => (
            <li key={w.cwd} role="none">
              <button
                type="button"
                className={
                  "workspace-picker__item" +
                  (w.cwd === cwd ? " workspace-picker__item--active" : "")
                }
                onClick={() => {
                  onSelectWorkspace(w.cwd);
                  close();
                }}
                role="menuitemradio"
                aria-checked={w.cwd === cwd}
                title={w.cwd}
              >
                <span className="workspace-picker__item-name">{shortName(w.cwd)}</span>
                <span className="workspace-picker__item-meta">
                  {w.sessionCount} 个会话
                </span>
                {w.cwd === cwd && <Check size={14} className="workspace-picker__check" />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
