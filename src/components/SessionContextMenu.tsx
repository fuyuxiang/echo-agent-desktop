import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  ArchiveIcon,
  DeleteIcon,
  EditToolIcon,
  LinkIcon,
  PinFilledIcon,
} from "@/foundation/components/Icon/icons";

const VIEWPORT_MARGIN = 8;
const MENU_ITEM_SELECTOR = '[role="menuitem"]:not(:disabled)';

function handleMenuKeyDown(
  event: ReactKeyboardEvent<HTMLElement>,
  onEscape: () => void,
): void {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    onEscape();
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;

  const items = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR),
  );
  if (items.length === 0) return;
  event.preventDefault();
  event.stopPropagation();
  const current = items.indexOf(document.activeElement as HTMLElement);
  if (event.key === "Home") items[0].focus();
  else if (event.key === "End") items[items.length - 1].focus();
  else if (event.key === "ArrowDown") {
    items[current < 0 ? 0 : (current + 1) % items.length].focus();
  } else {
    items[current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length].focus();
  }
}

export interface SessionContextMenuProps {
  x: number;
  y: number;
  sessionId: string;
  sessionTitle: string;
  isPinned?: boolean;
  isArchived?: boolean;
  onClose: () => void;
  onRename?: (sessionId: string, newTitle: string) => void | Promise<void>;
  onDelete?: (sessionId: string) => void;
  onPin?: (sessionId: string, pinned: boolean) => void | Promise<void>;
  onArchive?: (sessionId: string, archived: boolean) => void | Promise<void>;
  /** Removes only this project's reference; the underlying conversation remains. */
  onDetach?: (sessionId: string) => void;
}

/**
 * One menu for every session surface. It is portalled and viewport-clamped so
 * project rows near the edge of a panel never lose their destructive actions.
 */
export function SessionContextMenu({
  x,
  y,
  sessionId,
  sessionTitle,
  isPinned = false,
  isArchived = false,
  onClose,
  onRename,
  onDelete,
  onPin,
  onArchive,
  onDetach,
}: SessionContextMenuProps) {
  const [renaming, setRenaming] = useState(false);
  const [newTitle, setNewTitle] = useState(sessionTitle);
  const [position, setPosition] = useState({ left: x, top: y });
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(x, window.innerWidth - rect.width - VIEWPORT_MARGIN),
    );
    const top = Math.max(
      VIEWPORT_MARGIN,
      Math.min(y, window.innerHeight - rect.height - VIEWPORT_MARGIN),
    );
    setPosition({ left, top });
  }, [renaming, x, y]);

  useEffect(() => {
    if (renaming) {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else {
      menuRef.current?.querySelector<HTMLButtonElement>(MENU_ITEM_SELECTOR)?.focus();
    }
  }, [renaming]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [onClose]);

  const submitRename = () => {
    const trimmed = newTitle.trim();
    if (trimmed && trimmed !== sessionTitle) void onRename?.(sessionId, trimmed);
    onClose();
  };

  const menu = (
    <div
      ref={menuRef}
      className="context-menu"
      role="menu"
      aria-label={`${sessionTitle} 会话操作`}
      style={{ position: "fixed", ...position, zIndex: 1400 }}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => handleMenuKeyDown(event, () => {
        if (renaming) setRenaming(false);
        else onClose();
      })}
    >
      {renaming ? (
        <div className="context-menu__rename" role="none">
          <input
            ref={inputRef}
            id={`rename-${sessionId}`}
            type="text"
            aria-label="会话名称"
            value={newTitle}
            maxLength={200}
            onChange={(event) => setNewTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submitRename();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setNewTitle(sessionTitle);
                setRenaming(false);
              }
            }}
            className="context-menu__rename-input"
          />
          <div className="context-menu__rename-actions">
            <button type="button" onClick={() => setRenaming(false)}>取消</button>
            <button type="button" className="context-menu__rename-save" onClick={submitRename} disabled={!newTitle.trim()}>
              保存
            </button>
          </div>
        </div>
      ) : (
        <>
          {onRename && (
            <button type="button" role="menuitem" className="context-menu__item" onClick={() => setRenaming(true)}>
              <EditToolIcon size="sm" />
              <span>重命名</span>
            </button>
          )}
          {onPin && (
            <button type="button" role="menuitem" className="context-menu__item" onClick={() => { void onPin(sessionId, !isPinned); onClose(); }}>
              <PinFilledIcon size="sm" />
              <span>{isPinned ? "取消置顶" : "置顶"}</span>
            </button>
          )}
          {onArchive && (
            <button type="button" role="menuitem" className="context-menu__item" onClick={() => { void onArchive(sessionId, !isArchived); onClose(); }}>
              <ArchiveIcon size="sm" />
              <span>{isArchived ? "恢复会话" : "归档"}</span>
            </button>
          )}
          {onDetach && (
            <button type="button" role="menuitem" className="context-menu__item" onClick={() => { onDetach(sessionId); onClose(); }}>
              <LinkIcon size="sm" />
              <span>移出项目</span>
            </button>
          )}
          {onDelete && (
            <>
              <div className="context-menu__divider" role="separator" />
              <button type="button" role="menuitem" className="context-menu__item context-menu__item--danger" onClick={() => { onDelete(sessionId); onClose(); }}>
                <DeleteIcon size="sm" />
                <span>永久删除</span>
              </button>
            </>
          )}
        </>
      )}
    </div>
  );

  return typeof document === "undefined" ? null : createPortal(menu, document.body);
}
