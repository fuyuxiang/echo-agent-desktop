import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  automationClearBrowserData,
  automationPendingApprovals,
  automationRequestComputerPermissions,
  automationResolveApproval,
  automationSetPrivateNetwork,
  automationStatus,
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

interface AutomationControlsProps {
  sessionId: string | null;
  streaming: boolean;
  onToast?: (message: string) => void;
  onContinue?: () => boolean | void | Promise<boolean | void>;
  continueDisabled?: boolean;
  onPause?: () => boolean | void | Promise<boolean | void>;
  placement: "toolbar" | "approval";
}

interface AutomationSessionState {
  status: AutomationStatus | null;
  approvals: AutomationApproval[];
  error: string | null;
  isActive: () => boolean;
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
  const active = useRef(false);
  const statusRevision = useRef(0);
  const approvalRevision = useRef(0);
  const refreshRevision = useRef(0);
  const closedRequests = useRef(new Set<string>());
  const isActive = useCallback(() => active.current, []);

  const applyStatus = useCallback((next: AutomationStatus) => {
    if (!active.current || next.sessionId !== sessionId) return;
    statusRevision.current += 1;
    setStatus(next);
  }, [sessionId]);

  const removeApproval = useCallback((requestId: string) => {
    approvalRevision.current += 1;
    closedRequests.current.add(requestId);
    // Retain a bounded tombstone set for reordered native events.
    if (closedRequests.current.size > 256) {
      closedRequests.current.delete(closedRequests.current.values().next().value!);
    }
    setApprovals((current) => current.filter((item) => item.requestId !== requestId));
  }, []);

  const refresh = useCallback(async () => {
    if (!sessionId) {
      setStatus(null);
      setApprovals([]);
      setError(null);
      return;
    }
    const revision = ++refreshRevision.current;
    const statusAtStart = statusRevision.current;
    const approvalsAtStart = approvalRevision.current;
    const [nextStatus, nextApprovals] = await Promise.all([
      automationStatus(sessionId),
      automationPendingApprovals(sessionId),
    ]);
    if (!active.current || revision !== refreshRevision.current) return;
    if (statusRevision.current === statusAtStart && nextStatus.sessionId === sessionId) setStatus(nextStatus);
    const pending = nextApprovals.filter((item) => item.sessionId === sessionId && !closedRequests.current.has(item.requestId));
    setApprovals((current) => approvalRevision.current === approvalsAtStart ? pending : [
      ...pending,
      ...current.filter((item) => !pending.some((entry) => entry.requestId === item.requestId) && !closedRequests.current.has(item.requestId)),
    ]);
    setError(null);
  }, [sessionId]);

  useEffect(() => {
    let disposed = false;
    const unlisteners: UnlistenFn[] = [];
    active.current = true;
    setStatus(null);
    setApprovals([]);
    if (!hasTauriRuntime()) return () => { active.current = false; };

    const setup = async () => {
      try {
        const registered = await Promise.allSettled([
          onAutomationStatus((next) => {
            if (!disposed) applyStatus(next);
          }),
          onAutomationApproval((request) => {
            if (disposed || request.sessionId !== sessionId) return;
            if (closedRequests.current.has(request.requestId)) return;
            approvalRevision.current += 1;
            setApprovals((current) => current.some((item) => item.requestId === request.requestId)
              ? current
              : [...current, request]);
          }),
          onAutomationApprovalClosed((event) => {
            if (!disposed && event.sessionId === sessionId) {
              removeApproval(event.requestId);
            }
          }),
        ]);
        const listeners = registered.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
        const failed = registered.find((result) => result.status === "rejected");
        if (disposed || failed) {
          listeners.forEach((unlisten) => unlisten());
          if (failed?.status === "rejected") throw failed.reason;
          return;
        }
        unlisteners.push(...listeners);
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
      active.current = false;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [applyStatus, refresh, removeApproval, sessionId]);

  useEffect(() => {
    if (!sessionId || !hasTauriRuntime()) return;
    let disposed = false;
    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") {
        void refresh().catch((refreshError) => { if (!disposed) setError(friendlyError(refreshError)); });
      }
    };
    window.addEventListener("focus", refreshIfVisible);
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () => {
      disposed = true;
      window.removeEventListener("focus", refreshIfVisible);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, [refresh, sessionId]);

  return { status, approvals, error, isActive, refresh, setStatus: applyStatus, removeApproval };
}

function selectedAutomationMode(mode: AgentMode): AutomationMode {
  return mode === "browser_use" || mode === "computer_use" ? mode : "default";
}

function AutomationToolbar({
  sessionId, streaming, onToast, onContinue, continueDisabled = false, onPause, automation,
}: Omit<AutomationControlsProps, "placement"> & { automation: AutomationSessionState }) {
  const agentMode = useSessionStore((state) => state.agentMode);
  const mode = selectedAutomationMode(agentMode);
  const status = automation.status;
  const [busy, setBusy] = useState(false);
  const { requestConfirmation, dialog } = useAppDialog(sessionId);
  if (mode === "default") return null;
  const needsPermission = mode === "computer_use" && status?.computer.available
    && (!status.computer.screenCapture || !status.computer.inputControl);
  const reason = status?.task?.reason;
  const canContinue = mode === "browser_use" || Boolean(status?.task?.scope);
  const unavailable = mode === "computer_use" && status?.computer.desktopAvailable === false;
  const message = automation.error || (unavailable ? "桌面暂不可用，请解锁电脑后发送“继续”"
    : needsPermission ? "首次操作需要系统权限"
    : status?.paused ? !canContinue ? "请说明需要继续的电脑任务"
      : status.task?.phase === "stopped" ? "任务已停止，已有内容保留"
      : reason === "application_restarted" ? "任务已保留，发送“继续”即可续做"
      : reason === "validation_watchdog" ? "验收已超时暂停，已有内容保留"
      : reason === "prompt_failed" ? "本轮未能完成，已有内容保留，可继续或补充要求"
      : "任务已暂停，发送“继续”即可续做"
    : streaming ? "正在处理任务，可随时说“停一下”"
    : status?.computerAuthorized ? "可继续补充任务要求" : "");
  const run = async (operation: () => unknown) => {
    setBusy(true);
    try { const accepted = await operation(); if (accepted !== false && automation.isActive()) await automation.refresh(); }
    catch (error) { if (automation.isActive()) onToast?.(friendlyError(error)); }
    finally { if (automation.isActive()) setBusy(false); }
  };
  return <div className="task-execution-status" role="status">
    {message && <span>{message}</span>}
    {needsPermission && <button type="button" disabled={busy} onClick={() => void run(automationRequestComputerPermissions)}>打开系统权限设置</button>}
    {status?.paused && canContinue && onContinue && <button type="button" disabled={continueDisabled || busy || streaming || Boolean(needsPermission) || unavailable}
      onClick={() => void run(onContinue)}>继续任务</button>}
    {!status?.paused && !streaming && status?.computerAuthorized && onPause && <button type="button" disabled={busy}
      onClick={() => void run(onPause)}>暂停任务</button>}
    {mode === "browser_use" && <details><summary>浏览器数据与访问范围</summary>
      <label><input type="checkbox" checked={status?.allowPrivateNetwork ?? false} disabled={busy}
        onChange={event => void run(() => automationSetPrivateNetwork(sessionId!, event.target.checked))} />允许访问本机与内网</label>
      {status?.browserHasData && <button type="button" disabled={busy} onClick={() => requestConfirmation({
        title:"清除该任务的浏览器数据？", description:"将停止浏览器并删除 Cookie、缓存和下载。", confirmLabel:"清除数据", danger:true,
        action:() => run(() => automationClearBrowserData(sessionId!)),
      })}>清除浏览器数据</button>}
    </details>}
    {dialog}
  </div>;
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
      ["目标控件", target && typeof target.name === "string" ? target.name : typeof details.name === "string" ? details.name : ""],
      ["目标应用", typeof details.application === "string" ? details.application : typeof details.targetName === "string" ? details.targetName : ""],
      ["目标窗口", typeof details.windowName === "string" ? details.windowName : ""],
      ["控件角色", typeof details.role === "string" ? details.role : ""],
      ["控件标识", typeof details.identifier === "string" ? details.identifier : ""],
      ["原生动作", typeof details.nativeAction === "string" ? details.nativeAction : typeof details.action === "string" ? details.action : ""],
      ["应用路径", typeof details.appPath === "string" ? details.appPath : ""],
      ["文件", Array.isArray(details.files) ? details.files.join("、") : ""],
      ["文本长度", typeof details.characters === "number" ? `${details.characters} 个字符` : ""],
      ["按键", typeof details.key === "string" ? details.key : ""],
      ["组合键", Array.isArray(details.modifiers) ? details.modifiers.filter((m): m is string => typeof m === "string").join(" + ") : ""],
      ["显示器", typeof details.displayId === "string" ? details.displayId : ""],
    ].filter((row): row is [string, string] => Boolean(row[1]));
  }, [request]);

  useEffect(() => {
    if (request) rejectRef.current?.focus();
  }, [request]);

  if (!request) return null;
  const resolve = async (approved: boolean, allowForTask = false) => {
    setResolving(true);
    try {
      const found = allowForTask
        ? await automationResolveApproval(request.requestId, approved, true)
        : await automationResolveApproval(request.requestId, approved);
      if (!automation.isActive()) return;
      automation.removeApproval(request.requestId);
      if (!found) onToast?.("该确认已超时或被处理");
    } catch (error) {
      if (automation.isActive()) onToast?.(`无法回复安全确认：${friendlyError(error)}`);
    } finally {
      if (automation.isActive()) setResolving(false);
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

function SessionAutomationControls(props: AutomationControlsProps) {
  const automation = useAutomationSession(props.sessionId);
  return props.placement === "toolbar"
    ? <AutomationToolbar {...props} automation={automation} />
    : <AutomationApprovalCard automation={automation} onToast={props.onToast} />;
}

export function AutomationControls(props: AutomationControlsProps) {
  // A toolbar operation or IPC query belongs to the session that started it.
  // Remounting also prevents its busy/approval state leaking into another task.
  return <SessionAutomationControls key={props.sessionId ?? "none"} {...props} />;
}
