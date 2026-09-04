import { useEffect, useState } from "react";
import { usePermissionStore, selectPermissionForSession } from "@/stores/permission-store";
import { agentResolvePermission } from "@/lib/agent-client";

/**
 * Inline permission card rendered inside the ChatView message stream.
 * Only shows requests for the given session — never blocks sidebar or
 * conversation switching.
 */
export function PermissionInlineCard({ sessionId }: { sessionId: string | null }) {
  const head = usePermissionStore(selectPermissionForSession(sessionId));
  const dismiss = usePermissionStore((s) => s.dismiss);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBusy(false);
    setError(null);
  }, [head?.requestId]);

  if (!head) return null;

  const resolve = async (optionId?: string, cancelled = false) => {
    if (busy) return;
    const id = head.requestId;
    setBusy(true);
    setError(null);
    try {
      const acknowledged = await agentResolvePermission(id, { optionId, cancelled });
      if (!acknowledged) {
        throw new Error("后端未找到该权限请求，请重试");
      }
      dismiss(id, head.sessionId);
    } catch (e) {
      console.error("resolve permission failed", e);
      setError(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="perm-inline">
      <div className="perm-inline__head">
        <span className="perm-inline__kind">{head.toolKind}</span>
        <span className="perm-inline__title">{head.title}</span>
      </div>
      <div className="perm-inline__body">
        <p>EchoAgent 想要执行以下操作，是否允许？</p>
        {head.rawInput != null && (
          <pre className="perm-inline__raw">
            {JSON.stringify(head.rawInput, null, 2)}
          </pre>
        )}
        {error && <p className="perm-inline__error" role="alert">{error}</p>}
      </div>
      <div className="perm-inline__footer">
        <button className="btn btn--ghost" onClick={() => resolve(undefined, true)} disabled={busy}>
          取消
        </button>
        <button
          className="btn btn--danger"
          onClick={() => {
            const deny = head.options.find((o) => o.kind === "deny");
            resolve(deny?.optionId, !deny);
          }}
          disabled={busy}
        >
          拒绝
        </button>
        {head.options
          .filter((o) => o.kind === "allow" || o.kind === "allow_always")
          .map((o) => (
            <button
              key={o.optionId}
              className={
                "btn " + (o.kind === "allow_always" ? "btn--ghost" : "btn--primary")
              }
              onClick={() => resolve(o.optionId)}
              disabled={busy}
            >
              {o.title}
            </button>
          ))}
      </div>
    </div>
  );
}
