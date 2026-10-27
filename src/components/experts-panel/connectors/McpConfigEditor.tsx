import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeftIcon } from "@/foundation/components/Icon/icons";
import { mcpConfigPath, mcpConfigRead, mcpConfigSave } from "@/lib/agent-client";
import { useSessionStore } from "@/stores/session-store";
import { useAppDialog } from "../../AppDialog";
import { CapabilityError, CapabilityPage } from "../shared/CapabilityPage";

const EMPTY = "{\n  \"mcpServers\": {}\n}";

/** Raw mcp.json editor (截图 7): back / 取消 / 保存 header, the config-file
 *  path line, and a line-numbered monospace textarea. Validates JSON before
 *  saving; the backend also re-validates and mirrors entries into the runtime. */
export function McpConfigEditor({
  onBack, onSaved, onToast, embedded = false,
}: {
  onBack: () => void;
  onSaved?: () => void;
  onToast?: (m: string) => void;
  embedded?: boolean;
}) {
  const [filePath, setFilePath] = useState("");
  const [content, setContent] = useState("");
  const [original, setOriginal] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const loadGeneration = useRef(0);
  const gutterRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const { requestConfirmation, dialog } = useAppDialog();

  const loadConfig = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    setLoadError("");
    try {
      const [p, file] = await Promise.all([mcpConfigPath(), mcpConfigRead()]);
      if (loadGeneration.current !== generation) return;
      setFilePath(p || file.filePath);
      setContent(file.content || EMPTY);
      setOriginal(file.content || EMPTY);
    } catch (e) {
      if (loadGeneration.current !== generation) return;
      const message = String(e).replace(/^Error:\s*/, "");
      setLoadError(message);
      onToast?.(`读取配置失败：${message}`);
    } finally {
      if (loadGeneration.current === generation) setLoading(false);
    }
  }, [onToast]);
  useEffect(() => {
    void loadConfig();
    return () => { loadGeneration.current += 1; };
  }, [loadConfig]);

  const hasChanges = content !== original;
  const lineCount = content.split("\n").length;

  const syncGutter = () => {
    if (gutterRef.current && taRef.current) gutterRef.current.scrollTop = taRef.current.scrollTop;
  };

  const doBack = () => {
    if (saving) return;
    if (!hasChanges) {
      onBack();
      return;
    }
    requestConfirmation({
      title: "放弃未保存的修改？",
      description: "MCP 配置编辑器中的更改将丢失，原配置文件保持不变。",
      confirmLabel: "放弃修改",
      danger: true,
      action: onBack,
    });
  };

  const doSave = async () => {
    if (loading || saving || loadError || !hasChanges) return;
    const trimmed = content.trim();
    if (trimmed) {
      try { JSON.parse(trimmed); }
      catch (e) { setError(`无效的 JSON：${(e as Error).message}`); return; }
    }
    setError("");
    setSaving(true);
    try {
      // Pass the live session (when any) so EchoAgent applies the entries now;
      // without one the file is still saved for the next sync.
      const result = await mcpConfigSave(content, useSessionStore.getState().sessionId ?? undefined);
      setOriginal(content);
      if (result.warnings.length > 0) onToast?.(`连接器配置已保存，仍需注意：${result.warnings[0]}`);
      onSaved?.();
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setSaving(false);
    }
  };

  const contentBody = <>
      <div className="mcp-editor-path">
        <span className="mcp-editor-path-label">配置文件路径</span>
        <span className="mcp-editor-path-value">{filePath}</span>
        {hasChanges && <span className="mcp-editor-unsaved">未保存</span>}
      </div>
      <div className="mcp-editor-body">
        {loadError && <CapabilityError onRetry={() => void loadConfig()} retrying={loading}>读取配置失败：{loadError}。读取成功后才能编辑和保存。</CapabilityError>}
        {loading ? (
          <div className="capability-loading" role="status">加载中…</div>
        ) : loadError ? null : (
          <div className="mcp-code">
            <div ref={gutterRef} className="mcp-code-gutter" aria-hidden>
              {Array.from({ length: lineCount }, (_, i) => (
                <div key={i} className="mcp-code-ln">{i + 1}</div>
              ))}
            </div>
            <textarea
              ref={taRef}
              className="mcp-code-input"
              aria-label="MCP 配置内容"
              spellCheck={false}
              disabled={saving}
              value={content}
              onScroll={syncGutter}
              onChange={(e) => { setContent(e.target.value); setError(""); }}
            />
          </div>
        )}
        {error && <div className="mcp-editor-error" role="alert">{error}</div>}
      </div>
      {dialog}
  </>;
  const actions = <>
    <button type="button" className={embedded ? "capability-button" : "um-btn um-btn--grey"} onClick={doBack} disabled={saving}>取消</button>
    <button type="button" className={embedded ? "capability-button capability-button--primary" : "um-btn um-btn--primary"}
      disabled={!hasChanges || saving || loading || Boolean(loadError)} onClick={() => void doSave()}>
      {saving ? "保存中…" : "保存"}
    </button>
  </>;
  if (embedded) return <CapabilityPage title="配置连接器" className="capability-page--connector-editor" actions={actions}
    summary={<button type="button" className="mcp-editor-back" disabled={saving} onClick={doBack}>
      <ChevronLeftIcon size="sm" /><span>返回连接器列表</span>
    </button>}>
    {contentBody}
  </CapabilityPage>;

  return (
    <div className="mcp-editor">
      <div className="mcp-editor-head">
        <button type="button" className="mcp-editor-back" disabled={saving} onClick={doBack}>
          <ChevronLeftIcon size="sm" /><span>返回 MCP 列表</span>
        </button>
        <div className="mcp-editor-actions">{actions}</div>
      </div>
      {contentBody}
    </div>
  );
}
