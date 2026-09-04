/**
 * 对话页 TopBar 右侧操作菜单 — 对齐 EchoAgent 的更多操作：
 *  - 导出为 Markdown（把当前会话渲染成 .md 文件，经系统保存对话框落盘）
 *  - 置顶 / 取消置顶当前会话
 *  - 归档当前会话
 *
 * 位置：main-topbar 右侧（标题旁边）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { MoreDotsIcon, PinFilledIcon, ArchiveIcon } from "@/foundation/components/Icon/icons";
import { useSessionStore } from "@/stores/session-store";
import {
  exportTextFile,
  agentSetSessionPinned,
  agentSetSessionArchived,
} from "@/lib/agent-client";
import { buildSessionMarkdown, sanitizeFilename } from "@/lib/export-markdown";
import type { SessionSummary } from "@/lib/types";

interface TopbarActionsProps {
  sessionId: string;
  title: string;
  pinned?: boolean;
  onToast?: (msg: string) => void;
  /** After archive/pin mutations, parent merges the patch into the sessions store. */
  onSessionsChanged?: (patch?: Partial<SessionSummary>) => void;
  /** Called after the backend confirms archive state, so App can leave the hidden session. */
  onArchived?: (archived: boolean) => void;
}

export function TopbarActions({
  sessionId,
  title,
  pinned,
  onToast,
  onSessionsChanged,
  onArchived,
}: TopbarActionsProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Close dropdown on outside click.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const first = menuRef.current?.querySelector<HTMLButtonElement>("[role='menuitem']");
    first?.focus();
  }, [open]);

  const handleExport = useCallback(async () => {
    setOpen(false);
    setBusy(true);
    try {
      const messages = useSessionStore.getState().messages;
      if (messages.length === 0) {
        onToast?.("会话为空，没有可导出的内容");
        return;
      }
      const md = buildSessionMarkdown(messages, title);
      const suggested = sanitizeFilename(title || "对话导出") + ".md";
      const path = await exportTextFile(suggested, md, "md");
      if (!path) return; // user cancelled
      onToast?.(`已导出到 ${path}`);
    } catch (e) {
      onToast?.(`导出失败：${String(e).replace(/^Error:\s*/, "")}`);
    } finally {
      setBusy(false);
    }
  }, [title, onToast]);

  const handleTogglePin = useCallback(async () => {
    setOpen(false);
    setBusy(true);
    try {
      await agentSetSessionPinned(sessionId, !pinned);
      onToast?.(pinned ? "已取消置顶" : "已置顶");
      onSessionsChanged?.({ pinned: !pinned });
    } catch (e) {
      onToast?.(`操作失败：${String(e).replace(/^Error:\s*/, "")}`);
    } finally {
      setBusy(false);
    }
  }, [sessionId, pinned, onToast, onSessionsChanged]);

  const handleArchive = useCallback(async () => {
    setOpen(false);
    setBusy(true);
    try {
      const archived = await agentSetSessionArchived(sessionId, true);
      onToast?.("已归档（可在侧栏筛选中找回）");
      onSessionsChanged?.({ archived });
      onArchived?.(archived);
    } catch (e) {
      onToast?.(`归档失败：${String(e).replace(/^Error:\s*/, "")}`);
    } finally {
      setBusy(false);
    }
  }, [sessionId, onArchived, onToast, onSessionsChanged]);

  return (
    <div className="topbar-actions" ref={menuRef}>
      <button
        ref={triggerRef}
        type="button"
        className="main-topbar__btn"
        aria-label="更多操作"
        data-tip="更多操作"
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <MoreDotsIcon size="md" />
      </button>

      {open && (
        <div className="topbar-actions__menu" role="menu" aria-label="当前会话操作" onClick={(e) => e.stopPropagation()}>
          <button type="button" role="menuitem" className="topbar-actions__item" onClick={handleExport}>
            <span className="topbar-actions__item-icon">📄</span>
            <span>导出为 Markdown</span>
          </button>
          <button type="button" role="menuitem" className="topbar-actions__item" onClick={handleTogglePin}>
            <PinFilledIcon size="sm" />
            <span>{pinned ? "取消置顶" : "置顶会话"}</span>
          </button>
          <button type="button" role="menuitem" className="topbar-actions__item" onClick={handleArchive}>
            <ArchiveIcon size="sm" />
            <span>归档会话</span>
          </button>
        </div>
      )}
    </div>
  );
}
