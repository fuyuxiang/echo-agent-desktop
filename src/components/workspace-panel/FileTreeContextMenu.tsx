import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

const VIEWPORT_MARGIN = 8;
const MENU_ITEM_SELECTOR = '[role="menuitem"]:not(:disabled)';

export type ContextMenuItem =
  | {
      kind?: "item";
      id: string;
      label: string;
      shortcut?: string;
      icon?: ReactNode;
      danger?: boolean;
      disabled?: boolean;
      /** Insert a divider before this item. */
      dividerBefore?: boolean;
      tooltip?: string;
      onSelect: () => void | Promise<void>;
    }
  | {
      kind: "separator";
      id: string;
      dividerBefore?: boolean;
    }
  | {
      kind: "label";
      id: string;
      label: string;
    };

export interface FileTreeContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
  /** Called when an item's async onSelect throws. */
  onError?: (error: unknown) => void;
  ariaLabel?: string;
}

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

/**
 * Generic, declarative context menu for the file tree. Visual styling reuses the
 * `.context-menu` CSS that `SessionContextMenu` established. Items can declare
 * shortcuts, danger states, dividers and an async `onSelect` whose rejections
 * surface through `onError`.
 */
export function FileTreeContextMenu({
  x,
  y,
  items,
  onClose,
  onError,
  ariaLabel = "文件操作",
}: FileTreeContextMenuProps) {
  const [position, setPosition] = useState({ left: x, top: y });
  const submittingRef = useRef<string | null>(null);
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
  }, [items, x, y]);

  useEffect(() => {
    menuRef.current
      ?.querySelector<HTMLButtonElement>(MENU_ITEM_SELECTOR)
      ?.focus();
  }, []);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [onClose]);

  const handleSelect = async (item: ContextMenuItem) => {
    // Default kind is "item" when undefined, matching the union shape.
    if (item.kind === "separator" || item.kind === "label") return;
    if (item.disabled) return;
    if (submittingRef.current) return;
    submittingRef.current = item.id;
    try {
      await item.onSelect();
      onClose();
    } catch (error) {
      onError?.(error);
    } finally {
      submittingRef.current = null;
    }
  };

  const renderItem = (item: ContextMenuItem, idx: number) => {
    if (item.kind === "separator") {
      return (
        <div
          key={item.id}
          className="context-menu__divider"
          role="separator"
          data-testid={`ctx-separator-${idx}`}
        />
      );
    }
    if (item.kind === "label") {
      return (
        <div
          key={item.id}
          className="context-menu__group-label"
          data-testid={`ctx-label-${idx}`}
        >
          {item.label}
        </div>
      );
    }
    const cls = [
      "context-menu__item",
      item.danger ? "context-menu__item--danger" : "",
      item.disabled ? "context-menu__item--disabled" : "",
    ]
      .filter(Boolean)
      .join(" ");
    return (
      <button
        key={item.id}
        type="button"
        role="menuitem"
        className={cls}
        disabled={item.disabled}
        title={item.tooltip ?? item.label}
        onClick={(event) => {
          event.stopPropagation();
          void handleSelect(item);
        }}
      >
        {item.icon ? <span className="context-menu__icon">{item.icon}</span> : null}
        <span>{item.label}</span>
        {item.shortcut ? (
          <span className="context-menu__shortcut">{item.shortcut}</span>
        ) : null}
      </button>
    );
  };

  // Render with optional leading dividers.
  const rendered: ReactNode[] = [];
  items.forEach((item, idx) => {
    const dividerBefore = "dividerBefore" in item ? item.dividerBefore === true : false;
    if (dividerBefore && idx > 0) {
      rendered.push(
        <div
          key={`__divider-${item.id}`}
          className="context-menu__divider"
          role="separator"
        />,
      );
    }
    rendered.push(renderItem(item, idx));
  });

  const menu = (
    <div
      ref={menuRef}
      className="context-menu"
      role="menu"
      aria-label={ariaLabel}
      style={{ position: "fixed", ...position, zIndex: 1400 }}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => handleMenuKeyDown(event, onClose)}
    >
      {rendered}
    </div>
  );

  return typeof document === "undefined" ? null : createPortal(menu, document.body);
}
