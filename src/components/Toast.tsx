import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { toastMessage, type ToastMessageKind } from "@/lib/toast-message";

export interface ToastAction {
  label: string;
  onClick: () => void | Promise<void>;
}

/** Compact feedback with optional undo; diagnostics are disclosed on demand. */
export function Toast({
  message,
  actions = [],
  onDismiss,
  stacked = false,
  onPause,
  onActionError,
  kind = "auto",
}: {
  message: string | null;
  actions?: ToastAction[];
  onDismiss?: () => void;
  stacked?: boolean;
  onPause?: (paused: boolean) => void;
  onActionError?: (error: unknown) => void;
  kind?: ToastMessageKind;
}) {
  const presentation = useMemo(() => toastMessage(message ?? "", kind), [message, kind]);
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  useEffect(() => { onPause?.(expanded || hovered || focused); }, [expanded, hovered, focused, onPause]);
  useEffect(() => { setExpanded(false); }, [message]);
  if (!message) return null;
  return (
    <div
      className={`toast${stacked ? " toast--stacked" : ""}${actions.length > 0 ? " toast--actionable" : ""}`}
      role="status"
      aria-atomic="true"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}
    >
      <div className="toast__content">
        <span className="toast__message">{presentation.summary}</span>
        {presentation.details && <details className="toast__details" onToggle={event => setExpanded(event.currentTarget.open)}>
          <summary>查看详情</summary>
          <pre>{presentation.details}</pre>
        </details>}
      </div>
      {actions.length > 0 && (
        <span className="toast__actions">
          {actions.map((action) => (
            <button
              type="button"
              className="toast__action"
              key={action.label}
              onClick={() => {
                onDismiss?.();
                try {
                  const result = action.onClick();
                  if (result) void result.catch(error => onActionError?.(error));
                } catch (error) { onActionError?.(error); }
              }}
            >
              {action.label}
            </button>
          ))}
        </span>
      )}
      {onDismiss && <button type="button" className="toast__close" aria-label="关闭提示" onClick={onDismiss}><X size={14} /></button>}
    </div>
  );
}
