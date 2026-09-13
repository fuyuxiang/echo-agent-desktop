import { useEffect, useState } from "react";
import { usePermissionStore, selectPermissionForSession } from "@/stores/permission-store";
import { agentResolvePermission } from "@/lib/agent-client";
import type { PermissionOption, ToolKind } from "@/lib/types";

const TOOL_KIND_LABELS: Record<string, string> = {
  execute: "执行命令",
  run_terminal_command: "执行命令",
  edit: "修改文件",
  edit_file: "修改文件",
  read_file: "读取文件",
  web_fetch: "访问网页",
  web_search: "联网搜索",
};

function toolKindLabel(kind: ToolKind): string {
  return TOOL_KIND_LABELS[kind] ?? kind;
}

function persistentOptionLabel(option: PermissionOption): string {
  const title = option.title.trim();
  const scoped = title.match(/^always\s+(?:allow|reject):\s*(.+)$/i)?.[1]?.trim();

  if (option.kind === "allow_always") {
    if (/anything|always[ -]?approve/i.test(title)) return "本任务全部始终允许";
    if (scoped) return `始终允许 ${scoped}`;
    return "始终允许此类操作";
  }

  if (option.kind === "deny_always") {
    if (scoped) return `始终拒绝 ${scoped}`;
    return "始终拒绝此类操作";
  }

  return title || "其他选项";
}

function actionLabel(option: PermissionOption): string {
  if (option.kind === "allow") return "允许本次";
  if (option.kind === "deny") return "拒绝";
  return persistentOptionLabel(option);
}

/**
 * Inline permission card rendered inside the ChatView message stream.
 * Only shows requests for the given session — never blocks sidebar or
 * conversation switching.
 */
export function PermissionInlineCard({ sessionId }: { sessionId: string | null }) {
  const head = usePermissionStore(selectPermissionForSession(sessionId));
  const dismiss = usePermissionStore((s) => s.dismiss);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setResolvingId(null);
    setError(null);
  }, [head?.requestId]);

  if (!head) return null;

  const resolve = async (optionId?: string, cancelled = false, actionId = optionId) => {
    if (resolvingId) return;
    const id = head.requestId;
    setResolvingId(actionId ?? "cancel");
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
      setResolvingId(null);
    }
  };

  const immediateOptions = head.options.filter(
    (option) => option.kind === "allow" || option.kind === "deny",
  );
  const persistentOptions = head.options.filter(
    (option) => option.kind === "allow_always" || option.kind === "deny_always",
  );
  const otherOptions = head.options.filter(
    (option) => !immediateOptions.includes(option) && !persistentOptions.includes(option),
  );
  const hasDenyOption = immediateOptions.some((option) => option.kind === "deny");

  const optionButton = (option: PermissionOption, persistent = false) => {
    const label = actionLabel(option);
    const isDanger = option.kind === "deny" || option.kind === "deny_always";
    const isPrimary = option.kind === "allow";

    return (
      <button
        key={option.optionId}
        type="button"
        className={`btn perm-inline__action${
          isDanger ? " btn--danger" : isPrimary ? " btn--primary" : " btn--ghost"
        }`}
        title={option.title}
        onClick={() => resolve(option.optionId)}
        disabled={resolvingId != null}
      >
        <span className="perm-inline__action-label">
          {resolvingId === option.optionId ? "处理中…" : label}
        </span>
        {persistent && resolvingId !== option.optionId && (
          <span className="perm-inline__action-hint">
            {option.kind === "deny_always" ? "后续匹配操作自动拒绝" : "后续匹配操作不再询问"}
          </span>
        )}
      </button>
    );
  };

  return (
    <section className="perm-inline" aria-label="操作授权">
      <div className="perm-inline__head">
        <span className="perm-inline__kind">{toolKindLabel(head.toolKind)}</span>
        <span className="perm-inline__title" title={head.title}>{head.title}</span>
      </div>
      <div className="perm-inline__body">
        <p>EchoAgent 请求执行此操作，请确认授权范围。</p>
        {head.rawInput != null && (
          <details className="perm-inline__details">
            <summary>查看完整操作参数</summary>
            <pre className="perm-inline__raw">
              {JSON.stringify(head.rawInput, null, 2)}
            </pre>
          </details>
        )}
        {error && <p className="perm-inline__error" role="alert">{error}</p>}
      </div>
      <footer className="perm-inline__footer">
        <div className="perm-inline__actions" role="group" aria-label="本次操作">
          {!hasDenyOption && (
            <button
              type="button"
              className="btn btn--danger perm-inline__action"
              onClick={() => resolve(undefined, true, "deny")}
              disabled={resolvingId != null}
            >
              {resolvingId === "deny" ? "处理中…" : "拒绝"}
            </button>
          )}
          {immediateOptions.map((option) => optionButton(option))}
        </div>

        {persistentOptions.length > 0 && (
          <div className="perm-inline__persistent">
            <div className="perm-inline__section-title">
              <span>长期授权</span>
              <span>谨慎选择</span>
            </div>
            <div className="perm-inline__actions" role="group" aria-label="长期授权选项">
              {persistentOptions.map((option) => optionButton(option, true))}
            </div>
          </div>
        )}

        {otherOptions.length > 0 && (
          <div className="perm-inline__actions" role="group" aria-label="其他选项">
            {otherOptions.map((option) => optionButton(option))}
          </div>
        )}

        <button
          type="button"
          className="perm-inline__cancel"
          onClick={() => resolve(undefined, true, "cancel")}
          disabled={resolvingId != null}
        >
          {resolvingId === "cancel" ? "正在取消…" : "取消请求"}
        </button>
      </footer>
    </section>
  );
}
