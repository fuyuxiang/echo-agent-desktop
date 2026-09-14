import { useEffect, useRef, useState } from "react";
import { usePermissionStore, selectPermissionForSession } from "@/stores/permission-store";
import { agentResolvePermission, permissionModeSet } from "@/lib/agent-client";
import {
  permissionModeStatusFromEvent,
  usePermissionModeStore,
} from "@/stores/permission-mode-store";
import { useSessionsStore } from "@/stores/sessions-store";
import type { PermissionOption, ToolKind } from "@/lib/types";

/** Runtime-defined ACP option whose side effect must be completed by the client. */
const ENABLE_ALWAYS_APPROVE_OPTION_ID = "enable-always-approve";

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
  if (option.optionId === ENABLE_ALWAYS_APPROVE_OPTION_ID) return "本任务始终允许";
  if (option.kind === "allow") return "允许本次";
  if (option.kind === "deny") return "拒绝";
  return persistentOptionLabel(option);
}

function preferredOption(options: PermissionOption[], optionId: string): PermissionOption | undefined {
  return options.find((option) => option.optionId === optionId) ?? options[0];
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
  const [confirmingAlwaysId, setConfirmingAlwaysId] = useState<string | null>(null);
  const confirmCancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setResolvingId(null);
    setError(null);
    setConfirmingAlwaysId(null);
  }, [head?.requestId]);

  useEffect(() => {
    if (confirmingAlwaysId) confirmCancelRef.current?.focus();
  }, [confirmingAlwaysId]);

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

  const enableAlwaysOption = head.options.find(
    (option) => option.optionId === ENABLE_ALWAYS_APPROVE_OPTION_ID,
  );
  const allowOnceOptions = head.options.filter(
    (option) => option.kind === "allow" && option.optionId !== ENABLE_ALWAYS_APPROVE_OPTION_ID,
  );
  const denyOnceOptions = head.options.filter((option) => option.kind === "deny");
  const allowAlwaysOptions = head.options.filter((option) => option.kind === "allow_always");
  const denyAlwaysOptions = head.options.filter((option) => option.kind === "deny_always");
  const otherOptions = head.options.filter(
    (option) => option.kind === "other",
  );

  // ACP describes outcome kinds, not product-level intent. Collapse equivalent
  // one-shot choices and keep the task-wide Runtime toggle distinct even though
  // it deliberately arrives as AllowOnce on the wire.
  const allowOnceOption = preferredOption(allowOnceOptions, "allow-once");
  const denyOnceOption = preferredOption(denyOnceOptions, "reject-once");
  const scopedAlwaysOption = allowAlwaysOptions[0];
  const primaryAlwaysOption = scopedAlwaysOption ?? enableAlwaysOption;
  const primaryOptions = [allowOnceOption, primaryAlwaysOption, denyOnceOption]
    .filter((option): option is PermissionOption => Boolean(option));
  const primaryOptionIds = new Set(primaryOptions.map((option) => option.optionId));
  const advancedOptions = [
    ...allowAlwaysOptions.filter((option) => !primaryOptionIds.has(option.optionId)),
    ...(enableAlwaysOption && !primaryOptionIds.has(enableAlwaysOption.optionId)
      ? [enableAlwaysOption]
      : []),
    ...denyAlwaysOptions,
    ...otherOptions,
  ];

  const enableTaskAlways = async (option: PermissionOption) => {
    if (resolvingId) return;
    const requestId = head.requestId;
    const requestSessionId = head.sessionId;
    setConfirmingAlwaysId(null);
    setResolvingId(option.optionId);
    setError(null);
    let modeChanged = false;
    try {
      const result = await permissionModeSet(requestSessionId, "always-approve");
      modeChanged = true;
      const status = permissionModeStatusFromEvent(result);
      if (status) usePermissionModeStore.getState().setStatus(status);
      useSessionsStore.getState().upsert({
        sessionId: requestSessionId,
        permissionMode: result.permissionMode ?? "always-approve",
      });

      // Mode changes intentionally leave already-visible requests pending. The
      // special Runtime option also grants this in-flight operation once.
      const acknowledged = await agentResolvePermission(requestId, {
        optionId: option.optionId,
        cancelled: false,
      });
      if (!acknowledged) throw new Error("后端未找到该权限请求，请重试");
      dismiss(requestId, requestSessionId);
    } catch (e) {
      const message = String(e).replace(/^Error:\s*/, "");
      console.error("enable always-approve permission failed", e);
      setError(modeChanged
        ? `本任务已切换为“始终允许”，但当前操作确认失败：${message}`
        : `无法切换为“本任务始终允许”：${message}`);
    } finally {
      setResolvingId(null);
    }
  };

  const optionButton = (option: PermissionOption, persistent = false) => {
    const label = actionLabel(option);
    const isDanger = option.kind === "deny" || option.kind === "deny_always";
    const isTaskAlways = option.optionId === ENABLE_ALWAYS_APPROVE_OPTION_ID;
    const isPrimary = option.kind === "allow" && !isTaskAlways;

    return (
      <button
        key={option.optionId}
        type="button"
        className={`btn perm-inline__action${
          isDanger ? " btn--danger" : isPrimary ? " btn--primary" : " btn--ghost"
        }${isTaskAlways ? " perm-inline__action--elevated" : ""}`}
        title={option.title}
        onClick={() => {
          if (isTaskAlways) {
            setError(null);
            setConfirmingAlwaysId(option.optionId);
          } else {
            void resolve(option.optionId);
          }
        }}
        disabled={resolvingId != null}
      >
        <span className="perm-inline__action-label">
          {resolvingId === option.optionId ? "处理中…" : label}
        </span>
        {persistent && resolvingId !== option.optionId && (
          <span className="perm-inline__action-hint">
            {option.kind === "deny_always"
              ? "后续匹配操作自动拒绝"
              : isTaskAlways
                ? "当前任务后续操作不再询问"
                : "后续匹配操作不再询问"}
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
        <div className="perm-inline__actions perm-inline__actions--primary" role="group" aria-label="授权选择">
          {primaryOptions.map((option) => optionButton(
            option,
            option.kind === "allow_always" || option.optionId === ENABLE_ALWAYS_APPROVE_OPTION_ID,
          ))}
          {!denyOnceOption && (
            <button
              type="button"
              className="btn btn--danger perm-inline__action"
              onClick={() => resolve(undefined, true, "deny")}
              disabled={resolvingId != null}
            >
              {resolvingId === "deny" ? "处理中…" : "拒绝"}
            </button>
          )}
        </div>

        {confirmingAlwaysId && enableAlwaysOption && (
          <div
            className="perm-inline__confirm"
            role="alertdialog"
            aria-label="确认本任务始终允许"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setConfirmingAlwaysId(null);
              }
            }}
          >
            <strong>确认提高当前任务的权限？</strong>
            <span>将允许当前操作，且本任务后续的命令、文件修改等操作不再询问。</span>
            <div className="perm-inline__confirm-actions">
              <button
                ref={confirmCancelRef}
                type="button"
                className="btn btn--ghost"
                onClick={() => setConfirmingAlwaysId(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn--danger"
                onClick={() => void enableTaskAlways(enableAlwaysOption)}
              >
                确认并允许当前操作
              </button>
            </div>
          </div>
        )}

        {advancedOptions.length > 0 && (
          <details className="perm-inline__more">
            <summary>更多授权选项</summary>
            <div className="perm-inline__actions" role="group" aria-label="更多授权选项">
              {advancedOptions.map((option) => optionButton(
                option,
                option.kind === "allow_always" ||
                  option.kind === "deny_always" ||
                  option.optionId === ENABLE_ALWAYS_APPROVE_OPTION_ID,
              ))}
            </div>
          </details>
        )}
      </footer>
    </section>
  );
}
