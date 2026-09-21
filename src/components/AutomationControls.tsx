import { useCallback, useEffect, useMemo, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { setCodingMode } from "@/lib/agent-client";
import {
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

interface AutomationControlsProps {
  sessionId: string | null;
  streaming: boolean;
  onToast?: (message: string) => void;
  placement: "toolbar" | "approval";
}

interface AutomationSessionState {
  status: AutomationStatus | null;
  approvals: AutomationApproval[];
  refresh: () => Promise<void>;
  setStatus: (status: AutomationStatus) => void;
  removeApproval: (requestId: string) => void;
}

function useAutomationSession(sessionId: string | null): AutomationSessionState {
  const [status, setStatus] = useState<AutomationStatus | null>(null);
  const [approvals, setApprovals] = useState<AutomationApproval[]>([]);

  const refresh = useCallback(async () => {
    if (!sessionId) {
      setStatus(null);
      setApprovals([]);
      return;
    }
    const [nextStatus, nextApprovals] = await Promise.all([
      automationStatus(sessionId),
      automationPendingApprovals(sessionId),
    ]);
    setStatus(nextStatus);
    setApprovals(nextApprovals);
  }, [sessionId]);

  useEffect(() => {
    let disposed = false;
    const unlisteners: UnlistenFn[] = [];
    setStatus(null);
    setApprovals([]);

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
      } catch {
        // Browser preview and tests do not expose Tauri IPC. The controls stay
        // inert there; the desktop backend remains the source of truth.
      }
    };
    void setup();
    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [refresh, sessionId]);

  const removeApproval = useCallback((requestId: string) => {
    setApprovals((current) => current.filter((item) => item.requestId !== requestId));
  }, []);

  return { status, approvals, refresh, setStatus, removeApproval };
}

function selectedAutomationMode(mode: AgentMode): AutomationMode {
  return mode === "browser_use" || mode === "computer_use" ? mode : "default";
}

function statusText(status: AutomationStatus | null, mode: AutomationMode): string {
  if (!status) return mode === "default" ? "标准 Agent" : "正在检查自动化环境…";
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
  return "标准 Agent";
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

  const changeMode = (next: AutomationMode) => {
    if (!sessionId || next === mode) return;
    void run(async () => {
      await setCodingMode(sessionId, next === "default" ? "agent" : next);
      await automation.refresh();
    }, next === "default" ? "已切换到标准 Agent" : next === "browser_use" ? "已启用 Browser Use" : "已启用 Computer Use");
  };

  const computerNeedsPermission = mode === "computer_use" && status?.computer.available
    && (!status.computer.screenCapture || !status.computer.inputControl);

  return (
    <div className={`automation-control automation-control--${mode}`}>
      <label className="automation-control__mode">
        <span className="automation-control__dot" aria-hidden="true" />
        <span className="sr-only">任务模式</span>
        <select
          aria-label="任务模式"
          value={mode}
          disabled={!sessionId || streaming || busy}
          onChange={(event) => changeMode(event.target.value as AutomationMode)}
        >
          <option value="default">Agent</option>
          <option value="browser_use">Browser Use</option>
          <option value="computer_use">Computer Use</option>
        </select>
      </label>

      {mode !== "default" && (
        <>
          <span className="automation-control__summary" title={statusText(status, mode)}>
            {statusText(status, mode)}
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
              内网
            </label>
          )}
          {status?.paused ? (
            <button type="button" disabled={busy} onClick={() => void run(() => automationResume(sessionId!), "自动化已继续")}>继续</button>
          ) : (
            <button type="button" disabled={busy} onClick={() => void run(() => automationPause(sessionId!), "自动化已暂停，可以接管")}>接管</button>
          )}
          <button
            type="button"
            className="automation-control__end"
            disabled={busy}
            onClick={() => void run(async () => {
              await automationStop(sessionId!);
              await setCodingMode(sessionId!, "agent");
              await automation.refresh();
            }, "已结束自动化并切回 Agent")}
          >
            结束
          </button>
        </>
      )}
    </div>
  );
}

function AutomationApprovalCard({
  automation,
  onToast,
}: { automation: AutomationSessionState; onToast?: (message: string) => void }) {
  const request = automation.approvals[0];
  const [resolving, setResolving] = useState(false);
  const remaining = automation.approvals.length - 1;
  const detailText = useMemo(() => {
    if (!request?.details || typeof request.details !== "object") return "";
    return JSON.stringify(request.details, null, 2);
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
    <section className="automation-approval" role="alert" aria-live="assertive">
      <div className="automation-approval__icon" aria-hidden="true">!</div>
      <div className="automation-approval__body">
        <strong>{request.title}</strong>
        <p>{request.description}</p>
        {detailText && (
          <details>
            <summary>查看操作详情</summary>
            <pre>{detailText}</pre>
          </details>
        )}
        {remaining > 0 && <small>还有 {remaining} 个操作等待确认</small>}
      </div>
      <div className="automation-approval__actions">
        <button type="button" disabled={resolving} onClick={() => void resolve(false)}>拒绝</button>
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
