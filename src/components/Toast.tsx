export interface ToastAction {
  label: string;
  onClick: () => void | Promise<void>;
}

/** 底部居中的轻量提示。可逆操作可附带就地撤销和后续管理入口。 */
export function Toast({
  message,
  actions = [],
  onDismiss,
}: {
  message: string | null;
  actions?: ToastAction[];
  onDismiss?: () => void;
}) {
  if (!message) return null;
  return (
    <div className={`toast${actions.length > 0 ? " toast--actionable" : ""}`} role="status">
      <span className="toast__message">{message}</span>
      {actions.length > 0 && (
        <span className="toast__actions">
          {actions.map((action) => (
            <button
              type="button"
              className="toast__action"
              key={action.label}
              onClick={() => {
                onDismiss?.();
                void action.onClick();
              }}
            >
              {action.label}
            </button>
          ))}
        </span>
      )}
    </div>
  );
}
