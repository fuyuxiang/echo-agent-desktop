import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Globe2, Monitor, MoreHorizontal } from "lucide-react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { setCodingMode } from "@/lib/agent-client";
import {
  automationClearBrowserData,
  automationPause,
  automationPendingApprovals,
  automationRequestComputerPermissions,
  automationResolveApproval,
  automationResume,
  automationSetPrivateNetwork,
  automationStatus,
  automationStop,
  onAutomationApproval,
  onAutomationApprovalClosed,
  onAutomationStatus,
  type AutomationApproval,
  type AutomationMode,
  type AutomationStatus,
} from "@/lib/automation-client";
import { friendlyError } from "@/lib/error-format";
import { useSessionStore, type AgentMode } from "@/stores/session-store";
import { useAppDialog } from "./AppDialog";
import { HelpCircleIcon } from "@/foundation/components/Icon/icons";

interface AutomationControlsProps {
  sessionId: string | null;
  streaming: boolean;
  onToast?: (message: string) => void;
  placement: "toolbar" | "approval";
}

interface AutomationSessionState {
  status: AutomationStatus | null;
  approvals: AutomationApproval[];
  error: string | null;
  refresh: () => Promise<void>;
  setStatus: (status: AutomationStatus) => void;
  removeApproval: (requestId: string) => void;
}

function hasTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

function useAutomationSession(sessionId: string | null): AutomationSessionState {
  const [status, setStatus] = useState<AutomationStatus | null>(null);
  const [approvals, setApprovals] = useState<AutomationApproval[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!sessionId) {
      setStatus(null);
      setApprovals([]);
      setError(null);
      return;
    }
    const [nextStatus, nextApprovals] = await Promise.all([
      automationStatus(sessionId),
      automationPendingApprovals(sessionId),
    ]);
    setStatus(nextStatus);
    setApprovals(nextApprovals);
    setError(null);
  }, [sessionId]);

  useEffect(() => {
    let disposed = false;
    const unlisteners: UnlistenFn[] = [];
    setStatus(null);
    setApprovals([]);
    if (!hasTauriRuntime()) return;

    const setup = async () => {
      try {
        const registered = await Promise.all([
          onAutomationStatus((next) => {
            if (!disposed && next.sessionId === sessionId) setStatus(next);
          }),
          onAutomationApproval((request) => {
            if (disposed || request.sessionId !== sessionId) return;
            setApprovals((current) => current.some((item) => item.requestId === request.requestId)
              ? current
              : [...current, request]);
          }),
          onAutomationApprovalClosed((event) => {
            if (!disposed && event.sessionId === sessionId) {
              setApprovals((current) => current.filter((item) => item.requestId !== event.requestId));
            }
          }),
        ]);
        if (disposed) {
          registered.forEach((unlisten) => unlisten());
          return;
        }
        unlisteners.push(...registered);
        await refresh();
      } catch (setupError) {
        // Browser preview and tests do not expose Tauri IPC. The controls stay
        // inert there; the desktop backend remains the source of truth.
        if (!disposed) setError(friendlyError(setupError));
      }
    };
    void setup();
    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [refresh, sessionId]);

  useEffect(() => {
    if (!sessionId || !hasTauriRuntime()) return;
    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") {
        void refresh().catch((refreshError) => setError(friendlyError(refreshError)));
      }
    };
    window.addEventListener("focus", refreshIfVisible);
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () => {
      window.removeEventListener("focus", refreshIfVisible);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, [refresh, sessionId]);

  const removeApproval = useCallback((requestId: string) => {
    setApprovals((current) => current.filter((item) => item.requestId !== requestId));
  }, []);

  return { status, approvals, error, refresh, setStatus, removeApproval };
}

function selectedAutomationMode(mode: AgentMode): AutomationMode {
  return mode === "browser_use" || mode === "computer_use" ? mode : "default";
}

function statusText(status: AutomationStatus | null, mode: AutomationMode): string {
  if (!status) return mode === "default" ? "" : "正在检查可用性…";
  if (mode === "browser_use") {
    if (!status.browser.available) return status.browser.reason || "未找到兼容浏览器";
    if (status.paused) return "浏览器控制已暂停，你可以安全接管";
    if (status.browserRunning) {
      return status.browserTitle || status.browserUrl || `${status.browser.browserName || "浏览器"} 已连接`;
    }
    return `${status.browser.browserName || "浏览器"} 将在需要时自动启动`;
  }
  if (mode === "computer_use") {
    if (!status.computer.available) return status.computer.reason || "当前系统不支持电脑控制";
    if (!status.computer.screenCapture || !status.computer.inputControl) {
      return status.computer.reason || "需要屏幕录制和辅助功能权限";
    }
    return status.paused ? "电脑控制已暂停，你可以安全接管" : "屏幕与输入权限已就绪";
  }
  return "";
}

function AutomationToolbar({
  sessionId,
  streaming,
  onToast,
  automation,
}: Omit<AutomationControlsProps, "placement"> & { automation: AutomationSessionState }) {
  const agentMode = useSessionStore((state) => state.agentMode);
  const mode = selectedAutomationMode(agentMode);
  const [busy, setBusy] = useState(false);
  const status = automation.status;
  const { requestConfirmation, dialog } = useAppDialog(sessionId);

  const run = useCallback(async (operation: () => Promise<AutomationStatus | void>, success?: string) => {
    setBusy(true);
    try {
      const next = await operation();
      if (next) automation.setStatus(next);
      if (success) onToast?.(success);
    } catch (error) {
      onToast?.(friendlyError(error));
    } finally {
      setBusy(false);
    }
  }, [automation, onToast]);

  const computerNeedsPermission = mode === "computer_use" && status?.computer.available
    && (!status.computer.screenCapture || !status.computer.inputControl);

  if (mode === "default") return <>{dialog}</>;

  const modeLabel = mode === "browser_use" ? "操作网页" : "操作电脑";
  const ModeIcon = mode === "browser_use" ? Globe2 : Monitor;

  return (
    <div className={`automation-control automation-control--${mode}`}>
      <span
        className="automation-control__mode"
        title={`${modeLabel}启用时，相关网页或屏幕内容会发送给当前模型`}
      >
        <ModeIcon size={14} strokeWidth={1.9} aria-hidden="true" />
        <span>{modeLabel}</span>
      </span>
      <button
        type="button"
        className="automation-control__hint"
        aria-label={`查看${modeLabel}的安全确认说明`}
        title={`${modeLabel}中可能产生副作用的步骤会在执行前单独确认`}
        data-tip={`${modeLabel}中可能产生副作用的步骤会在执行前单独确认`}
      >
        <HelpCircleIcon size="sm" aria-hidden="true" />
      </button>
      <span className="automation-control__summary" title={automation.error || statusText(status, mode)}>
        {automation.error || statusText(status, mode)}
      </span>
      {computerNeedsPermission && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(async () => {
            await automationRequestComputerPermissions();
            await automation.refresh();
          }, "已打开系统权限设置，授权后请回到 EchoAgent")}
        >
          授予权限
        </button>
      )}
      <details className="automation-control__more">
        <summary role="button" aria-label="更多自动化选项" title="更多选项">
          <MoreHorizontal size={16} aria-hidden="true" />
        </summary>
        <div className="automation-control__more-menu">
          <p>网页或屏幕内容会发送给当前模型。</p>
          {mode === "browser_use" && status?.browser.available && (
            <label className="automation-control__private" title="默认阻止本机、局域网和企业内网地址">
              <input
                type="checkbox"
                checked={status.allowPrivateNetwork}
                disabled={busy}
                onChange={(event) => {
                  const allowed = event.target.checked;
                  void run(() => automationSetPrivateNetwork(sessionId!, allowed));
                }}
              />
              允许访问本机与内网
            </label>
          )}
          {mode === "browser_use" && status?.browserHasData && (
            <button
              type="button"
              disabled={busy}
              title="停止受控浏览器并删除该任务的 Cookie、登录状态、缓存和下载"
              onClick={() => requestConfirmation({
                title: "清除该任务的浏览器数据？",
                description: "将停止受控浏览器，并删除 Cookie、登录状态、缓存和已下载文件。此操作无法撤销。",
                confirmLabel: "清除数据",
                danger: true,
                action: () => run(
                  () => automationClearBrowserData(sessionId!),
                  "浏览器数据已清除，自动化保持暂停",
                ),
              })}
            >
              清除本任务浏览器数据
            </button>
          )}
        </div>
      </details>
      {status?.paused ? (
        <button type="button" disabled={busy || streaming} onClick={() => void run(() => automationResume(sessionId!), "已继续执行")}>继续</button>
      ) : (
        <button type="button" disabled={busy} onClick={() => void run(() => automationPause(sessionId!), "已暂停，现在可以安全接管")}>接管</button>
      )}
      <button
        type="button"
        className="automation-control__end"
        disabled={busy}
        onClick={() => void run(async () => {
          await automationStop(sessionId!);
          await setCodingMode(sessionId!, "agent");
          useSessionStore.getState().setAgentMode("default", sessionId!);
          await automation.refresh();
        }, `已结束${modeLabel}`)}
      >
        结束
      </button>
      {dialog}
    </div>
  );
}

function AutomationApprovalCard({
  automation,
  onToast,
}: { automation: AutomationSessionState; onToast?: (message: string) => void }) {
  const request = automation.approvals[0];
  const [resolving, setResolving] = useState(false);
  const rejectRef = useRef<HTMLButtonElement>(null);
  const remaining = automation.approvals.length - 1;
  const detailRows = useMemo(() => {
    if (!request?.details || typeof request.details !== "object") return [];
    const details = request.details as Record<string, unknown>;
    const target = details.target && typeof details.target === "object"
      ? details.target as Record<string, unknown>
      : null;
    const safeUrl = typeof details.url === "string" ? (() => {
      try {
        const parsed = new URL(details.url as string);
        return `${parsed.origin}${parsed.pathname}`.slice(0, 300);
      } catch {
        return "";
      }
    })() : "";
    return [
      ["网站", safeUrl],
      ["页面", typeof details.pageTitle === "string" ? details.pageTitle : ""],
      ["目标控件", target && typeof target.name === "string" ? target.name : ""],
      ["目标应用", typeof details.targetName === "string" ? details.targetName : ""],
      ["文件", Array.isArray(details.files) ? details.files.join("、") : ""],
      ["文本长度", typeof details.characters === "number" ? `${details.characters} 个字符` : ""],
      ["按键", typeof details.key === "string" ? details.key : ""],
      ["显示器", typeof details.displayId === "string" ? details.displayId : ""],
    ].filter((row): row is [string, string] => Boolean(row[1]));
  }, [request]);

  useEffect(() => {
    if (request) rejectRef.current?.focus();
  }, [request]);

  if (!request) return null;
  const resolve = async (approved: boolean) => {
    setResolving(true);
    try {
      const found = await automationResolveApproval(request.requestId, approved);
      automation.removeApproval(request.requestId);
      if (!found) onToast?.("该确认已超时或被处理");
    } catch (error) {
      onToast?.(`无法回复安全确认：${friendlyError(error)}`);
    } finally {
      setResolving(false);
    }
  };

  return (
    <section className="automation-approval" role="alertdialog" aria-modal="true" aria-labelledby="automation-approval-title">
      <div className="automation-approval__icon" aria-hidden="true">!</div>
      <div className="automation-approval__body">
        <strong id="automation-approval-title">{request.title}</strong>
        <p>{request.description}</p>
        {detailRows.length > 0 && (
          <dl className="automation-approval__details">
            {detailRows.map(([label, value]) => (
              <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
            ))}
          </dl>
        )}
        {remaining > 0 && <small>还有 {remaining} 个操作等待确认</small>}
      </div>
      <div className="automation-approval__actions">
        <button ref={rejectRef} type="button" disabled={resolving} onClick={() => void resolve(false)}>拒绝</button>
        <button type="button" className="automation-approval__approve" disabled={resolving} onClick={() => void resolve(true)}>
          允许本次
        </button>
      </div>
    </section>
  );
}

export function AutomationControls(props: AutomationControlsProps) {
  const automation = useAutomationSession(props.sessionId);
  return props.placement === "toolbar"
    ? <AutomationToolbar {...props} automation={automation} />
    : <AutomationApprovalCard automation={automation} onToast={props.onToast} />;
}
