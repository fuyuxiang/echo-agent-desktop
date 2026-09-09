/**
 * 对话页 TopBar 右侧操作菜单：
 *  - 导出为 Markdown
 *  - 置顶 / 取消置顶当前会话
 *  - 归档当前会话
 *
 * 菜单通过 body portal + fixed 坐标渲染。顶栏和会话工具栏都使用
 * backdrop-filter，会分别建立 stacking context；把菜单留在顶栏 DOM 内时，
 * 即使菜单自身 z-index 很大，也会被后面的错误条/工具栏盖住并失去点击。
 */
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  ArchiveIcon,
  FileTextIcon,
  LoadingIcon,
  MoreDotsIcon,
  PinFilledIcon,
} from "@/foundation/components/Icon/icons";
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

type MenuFocusEdge = "first" | "last";

interface MenuPosition {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  placement: "top" | "bottom";
}

const MENU_MARGIN = 8;
const MENU_OFFSET = 6;
const MENU_ESTIMATED_WIDTH = 184;
const MENU_ESTIMATED_HEIGHT = 124;
const MENU_Z_INDEX = 1200;
const MENU_ITEM_SELECTOR = '[role="menuitem"]:not(:disabled)';

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
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pendingFocusRef = useRef<MenuFocusEdge | null>(null);

  const closeMenu = useCallback((restoreFocus = false) => {
    setOpen(false);
    setMenuPosition(null);
    if (restoreFocus) {
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }, []);

  const openMenu = useCallback((focusEdge: MenuFocusEdge = "first") => {
    if (busy) return;
    pendingFocusRef.current = focusEdge;
    setOpen(true);
  }, [busy]);

  const updateMenuPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    if (
      rect.bottom < 0 || rect.top > viewportHeight
      || rect.right < 0 || rect.left > viewportWidth
    ) {
      closeMenu();
      return;
    }

    const measuredWidth = menuRef.current?.offsetWidth || MENU_ESTIMATED_WIDTH;
    // scrollHeight keeps the full height even when a small window applies maxHeight.
    const measuredHeight = menuRef.current?.scrollHeight
      || menuRef.current?.offsetHeight
      || MENU_ESTIMATED_HEIGHT;
    const menuWidth = Math.min(
      measuredWidth,
      Math.max(0, viewportWidth - MENU_MARGIN * 2),
    );
    const spaceBelow = viewportHeight - rect.bottom - MENU_OFFSET - MENU_MARGIN;
    const spaceAbove = rect.top - MENU_OFFSET - MENU_MARGIN;
    const placement = spaceBelow >= measuredHeight || spaceBelow >= spaceAbove
      ? "bottom"
      : "top";
    const availableHeight = Math.max(0, placement === "bottom" ? spaceBelow : spaceAbove);
    const renderedHeight = Math.min(measuredHeight, availableHeight);
    const maxLeft = Math.max(MENU_MARGIN, viewportWidth - menuWidth - MENU_MARGIN);
    const left = Math.min(Math.max(MENU_MARGIN, rect.right - menuWidth), maxLeft);
    const desiredTop = placement === "bottom"
      ? rect.bottom + MENU_OFFSET
      : rect.top - MENU_OFFSET - renderedHeight;
    const maxTop = Math.max(MENU_MARGIN, viewportHeight - renderedHeight - MENU_MARGIN);
    const top = Math.min(Math.max(MENU_MARGIN, desiredTop), maxTop);

    setMenuPosition({ left, top, width: menuWidth, maxHeight: availableHeight, placement });
  }, [closeMenu]);

  // Measure before paint, then keep the portal aligned while the desktop window moves/resizes.
  useLayoutEffect(() => {
    if (!open) return;
    updateMenuPosition();
    const frame = window.requestAnimationFrame(updateMenuPosition);
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [open, updateMenuPosition]);

  // A portalled menu is not contained by rootRef, so outside-click checks both trees.
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      closeMenu();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeMenu(true);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, closeMenu]);

  useEffect(() => {
    if (!open || !menuPosition || !pendingFocusRef.current) return;
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(MENU_ITEM_SELECTOR) ?? [],
    );
    items[pendingFocusRef.current === "first" ? 0 : items.length - 1]?.focus();
    pendingFocusRef.current = null;
  }, [open, menuPosition]);

  // Never leave one session's menu open after navigation reuses this component.
  useEffect(() => {
    closeMenu();
  }, [sessionId, closeMenu]);

  const restoreTriggerFocus = useCallback(() => {
    window.requestAnimationFrame(() => {
      if (triggerRef.current?.isConnected) triggerRef.current.focus();
    });
  }, []);

  const handleExport = useCallback(async () => {
    closeMenu();
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
      restoreTriggerFocus();
    }
  }, [title, onToast, closeMenu, restoreTriggerFocus]);

  const handleTogglePin = useCallback(async () => {
    closeMenu();
    setBusy(true);
    try {
      await agentSetSessionPinned(sessionId, !pinned);
      onToast?.(pinned ? "已取消置顶" : "已置顶");
      onSessionsChanged?.({ pinned: !pinned });
    } catch (e) {
      onToast?.(`操作失败：${String(e).replace(/^Error:\s*/, "")}`);
    } finally {
      setBusy(false);
      restoreTriggerFocus();
    }
  }, [sessionId, pinned, onToast, onSessionsChanged, closeMenu, restoreTriggerFocus]);

  const handleArchive = useCallback(async () => {
    closeMenu();
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
      restoreTriggerFocus();
    }
  }, [sessionId, onArchived, onToast, onSessionsChanged, closeMenu, restoreTriggerFocus]);

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "Tab") {
      closeMenu();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;

    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(MENU_ITEM_SELECTOR),
    );
    if (items.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Home") items[0].focus();
    else if (event.key === "End") items[items.length - 1].focus();
    else if (event.key === "ArrowDown") items[current < 0 ? 0 : (current + 1) % items.length].focus();
    else items[current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length].focus();
  };

  const menuStyle: CSSProperties = menuPosition
    ? {
        position: "fixed",
        left: menuPosition.left,
        top: menuPosition.top,
        width: menuPosition.width,
        minWidth: menuPosition.width,
        maxHeight: menuPosition.maxHeight,
        overflowY: "auto",
        zIndex: MENU_Z_INDEX,
      }
    : { position: "fixed", visibility: "hidden" };

  return (
    <div className="topbar-actions" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="main-topbar__btn"
        aria-label="更多操作"
        data-tip={busy ? "正在处理会话操作" : "更多操作"}
        disabled={busy}
        aria-busy={busy}
        aria-haspopup="menu"
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          if (open) closeMenu();
          else openMenu();
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          openMenu(event.key === "ArrowUp" ? "last" : "first");
        }}
      >
        {busy ? <LoadingIcon size="md" spin /> : <MoreDotsIcon size="md" />}
      </button>

      {open && typeof document !== "undefined" && createPortal(
        <div
          ref={menuRef}
          id={menuId}
          className="topbar-actions__menu"
          style={menuStyle}
          role="menu"
          aria-label="当前会话操作"
          data-placement={menuPosition?.placement}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={handleMenuKeyDown}
        >
          <button type="button" role="menuitem" className="topbar-actions__item" onClick={handleExport}>
            <FileTextIcon size="sm" />
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
        </div>,
        document.body,
      )}
    </div>
  );
}
