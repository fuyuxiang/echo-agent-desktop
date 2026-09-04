/**
 * Token-authorization form — shown when connecting a `auth_mode: "token"`
 * connector (天眼查 / Bugly / 携程问道 etc.). Renders the connector's
 * `token-schema.json` fields; on submit the collected values are injected as
 * env vars into the connector's MCP servers.
 *
 * Mirrors echo-agent's `ConnectorTokenDialog` / detail-panel token form.
 */
import { useState } from "react";
import type { ConnectorItem } from "@/lib/types";
import { OpenExternalIcon } from "@/foundation/components/Icon/icons";
import { ConnectorIcon } from "../shared/ConnectorIcon";
import { useModalFocus } from "@/lib/use-modal-focus";
import { openUrl } from "@/lib/agent-client";

interface Props {
  connector: ConnectorItem;
  /** Values saved from a previous install (read back from mcp.json). */
  initialValues?: Record<string, string>;
  onClose: () => void;
  onSubmit: (values: Record<string, string>) => void;
}

export function ConnectorTokenForm({ connector, initialValues, onClose, onSubmit }: Props) {
  const schema = connector.tokenSchema!;
  const [values, setValues] = useState<Record<string, string>>(initialValues ?? {});
  const [docError, setDocError] = useState<string | null>(null);
  const dialogRef = useModalFocus<HTMLFormElement>(true, onClose);

  const requiredFields = schema.fields.filter((f) => f.required);
  const allRequiredFilled = requiredFields.every((f) => (values[f.key] ?? "").trim());

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!allRequiredFilled) return;
    onSubmit(values);
  };

  const handleOpenDocs = async () => {
    if (!schema.docUrl) return;
    setDocError(null);
    try {
      await openUrl(schema.docUrl);
    } catch (error) {
      setDocError(`无法打开帮助链接：${String(error).replace(/^Error:\s*/, "")}`);
    }
  };

  return (
    <div className="ec-modal-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form ref={dialogRef} className="ec-modal" onSubmit={handleSubmit} role="dialog" aria-modal="true" aria-label={schema.title || `${connector.name} 授权`} tabIndex={-1}>
        <button type="button" className="ec-modal-close" onClick={onClose} aria-label="关闭">×</button>

        <div className="ec-modal-header">
          <ConnectorIcon local={connector.iconLocal} name={connector.name} size={48} shape="square" />
          <div className="ec-modal-info">
            <div className="ec-modal-title">{schema.title || `${connector.name} 授权`}</div>
            {schema.description && <p className="ec-modal-desc">{schema.description}</p>}
          </div>
        </div>

        {schema.docUrl && (
          <button type="button" className="cn-token-doclink" onClick={() => void handleOpenDocs()}>
            <OpenExternalIcon size="sm" /><span>{schema.docLabel || "如何获取？"}</span>
          </button>
        )}
        {docError && <p className="ec-modal-error" role="alert">{docError}</p>}

        <div className="cn-token-fields">
          {schema.fields.map((f) => (
            <label key={f.key} className="cn-token-field">
              <span className="cn-token-label">
                {f.label || f.key}
                {f.required && <span className="cn-token-required">*</span>}
              </span>
              <input
                className="cn-token-input"
                type={f.type === "password" ? "password" : "text"}
                placeholder={f.placeholder || ""}
                value={values[f.key] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                data-modal-initial-focus={f === schema.fields[0] ? "" : undefined}
              />
              {f.description && <span className="cn-token-help">{f.description}</span>}
            </label>
          ))}
        </div>

        <button type="submit" className="ec-modal-summon-btn" disabled={!allRequiredFilled}>
          连接
        </button>
      </form>
    </div>
  );
}
