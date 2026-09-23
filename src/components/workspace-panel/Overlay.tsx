import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useAnchoredFloating, type FloatingAlignment, type FloatingPlacement } from "@/lib/use-anchored-floating";
import { useModalFocus } from "@/lib/use-modal-focus";

interface PopoverProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
  anchorRef?: RefObject<HTMLElement | null>;
  placement?: FloatingPlacement;
  align?: FloatingAlignment;
  role?: "dialog" | "menu" | "listbox";
}

export function Popover({
  open,
  onClose,
  children,
  className,
  ariaLabel,
  anchorRef,
  placement = "top",
  align = "end",
  role = "dialog",
}: PopoverProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const fallbackAnchorRef = useRef<HTMLElement | null>(null);
  const activeAnchorRef = anchorRef ?? fallbackAnchorRef;
  const floating = useAnchoredFloating(activeAnchorRef, ref, open && Boolean(anchorRef), {
    preferredPlacement: placement,
    align,
    estimatedHeight: 260,
  });

  useEffect(() => {
    if (!open || role === "dialog") return;
    const surface = ref.current;
    const frame = window.requestAnimationFrame(() => {
      surface?.querySelector<HTMLElement>(
        '[role="menuitem"], [role="menuitemradio"], [role="option"], button:not([disabled])',
      )?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (anchorRef?.current?.isConnected && surface?.contains(document.activeElement)) {
        anchorRef.current.focus();
      }
    };
  }, [anchorRef, open, role]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!ref.current?.contains(target) && !anchorRef?.current?.contains(target)) onClose();
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKey);
    };
  }, [anchorRef, open, onClose]);

  if (!open) return null;
  return createPortal(
    <div
      ref={ref}
      role={role}
      aria-label={ariaLabel}
      className={`overlay-popover${className ? ` ${className}` : ""}`}
      style={anchorRef ? floating.style : undefined}
      data-placement={floating.placement ?? undefined}
      onKeyDown={(event) => {
        if (role === "dialog" || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        const items = [...(ref.current?.querySelectorAll<HTMLElement>(
          '[role="menuitem"], [role="menuitemradio"], [role="option"], button:not([disabled])',
        ) ?? [])];
        if (items.length === 0) return;
        event.preventDefault();
        const current = Math.max(0, items.indexOf(document.activeElement as HTMLElement));
        const next = event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : event.key === "ArrowDown"
              ? (current + 1) % items.length
              : (current - 1 + items.length) % items.length;
        items[next]?.focus();
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  delayMs?: number;
}

export function Tooltip({ content, children, delayMs = 200 }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const timer = useRef<number | null>(null);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const tooltipRef = useRef<HTMLSpanElement | null>(null);
  const tooltipId = useId();
  const floating = useAnchoredFloating(anchorRef, tooltipRef, open, {
    preferredPlacement: "bottom",
    align: "center",
    estimatedHeight: 48,
  });
  const show = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(true), delayMs);
  };
  const hide = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setOpen(false);
  };
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  return (
    <span
      ref={anchorRef}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      className="overlay-tooltip__anchor"
      aria-describedby={open ? tooltipId : undefined}
    >
      {children}
      {open && createPortal(
        <span
          ref={tooltipRef}
          id={tooltipId}
          role="tooltip"
          className="overlay-tooltip"
          style={floating.style}
          data-placement={floating.placement ?? undefined}
        >{content}</span>,
        document.body,
      )}
    </span>
  );
}

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  inline?: boolean;
}

export function Modal({ open, onClose, title, children, inline = false }: ModalProps) {
  const ref = useModalFocus<HTMLDivElement>(open && !inline, onClose);
  const labelId = useId();

  useEffect(() => {
    if (!open || inline) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, inline, onClose]);

  if (!open) return null;
  return createPortal(
    <div className={`overlay-modal${inline ? " overlay-modal--inline" : ""}`}>
      {!inline && <div className="overlay-modal__scrim" onClick={onClose} />}
      <div
        ref={ref}
        role="dialog"
        aria-modal={inline ? undefined : "true"}
        aria-labelledby={labelId}
        className="overlay-modal__panel"
        tabIndex={-1}
      >
        <h2 id={labelId} className="overlay-modal__title">{title}</h2>
        <button
          type="button"
          className="overlay-modal__close"
          aria-label="关闭"
          onClick={onClose}
        >
          ✕
        </button>
        <div className="overlay-modal__body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
