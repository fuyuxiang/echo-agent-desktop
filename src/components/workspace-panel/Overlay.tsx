import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface PopoverProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
}

export function Popover({ open, onClose, children, className, ariaLabel }: PopoverProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
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
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={ariaLabel}
      className={`overlay-popover${className ? ` ${className}` : ""}`}
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
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      className="overlay-tooltip__anchor"
    >
      {children}
      {open && createPortal(
        <span role="tooltip" className="overlay-tooltip">{content}</span>,
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
  const ref = useRef<HTMLDivElement | null>(null);
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