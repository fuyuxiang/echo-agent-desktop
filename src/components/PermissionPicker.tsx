/**
 * 任务级权限模式选择器 - Composer meta 行的下拉
 *
 * EchoAgent 任务级权限的三档选择:
 *  - ask            审批模式:每次工具调用都弹确认
 *  - auto           自动模式:EchoAgent 的分类器自动批准安全操作
 *  - always-approve 始终允许:所有工具调用自动批准
 *
 * 首页选择只属于即将创建的任务；已有会话通过 sessionId
 * 定向同步，绝不影响其他任务。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDownIcon,
  CheckIcon,
  ShieldCheckIcon,
} from "@/foundation/components/Icon/icons";
import { permissionModeGet, permissionModeSet } from "@/lib/agent-client";
import type { PermissionMode } from "@/lib/agent-client";
import {
  permissionModeStatusFromEvent,
  usePermissionModeStore,
} from "@/stores/permission-mode-store";
import { useSessionsStore } from "@/stores/sessions-store";

const MODES: { id: PermissionMode; label: string; desc: string }[] = [
  {
    id: "ask",
    label: "审批模式",
    desc: "当前任务的敏感操作需要你确认",
  },
  {
    id: "auto",
    label: "自动模式",
    desc: "当前任务的常规操作自动执行，高风险操作仍会询问",
  },
  {
    id: "always-approve",
    label: "本任务始终允许",
    desc: "仅当前任务的后续工具调用会自动批准",
  },
];

export function PermissionPicker({
  onToast,
  triggerLabel,
  sessionId,
}: {
  onToast?: (msg: string) => void;
  /** 覆盖触发按钮文字（如本地助理页固定显示「默认权限」）；缺省显示当前模式名。 */
  triggerLabel?: string;
  /** Existing task scope. Omit on Home for the one pending new-task draft. */
  sessionId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [confirmingAlways, setConfirmingAlways] = useState(false);
  const homeMode = usePermissionModeStore((state) => state.homeMode);
  const status = usePermissionModeStore((state) => sessionId
    ? state.statuses[sessionId] ?? null
    : state.capabilityStatus);
  const setHomeMode = usePermissionModeStore((state) => state.setHomeMode);
  const setStatus = usePermissionModeStore((state) => state.setStatus);
  const catalogMode = useSessionsStore((state) => sessionId
    ? state.independent.find((entry) => entry.sessionId === sessionId)?.permissionMode
    : undefined);
  const [busy, setBusy] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);
  const alwaysOptionRef = useRef<HTMLButtonElement>(null);
  const confirmCancelRef = useRef<HTMLButtonElement>(null);
  const requestRef = useRef(0);

  const runtimeMode = status &&
      (status.runtimeSyncState === "failed" || status.runtimeSyncState === "syncing") &&
      status.runtimeAppliedMode
    ? status.runtimeAppliedMode
    : status?.permissionMode;
  const mode: PermissionMode = status?.locked
    ? status.permissionMode
    : sessionId
      ? runtimeMode ?? catalogMode ?? "ask"
      : homeMode;

  useEffect(() => {
    const request = ++requestRef.current;
    permissionModeGet(sessionId)
      .then((status) => {
        if (requestRef.current !== request) return;
        setStatus(status);
        if (sessionId) {
          useSessionsStore.getState().upsert({
            sessionId,
            permissionMode: status.permissionMode,
          });
        } else {
          const selected = usePermissionModeStore.getState().homeMode;
          if (
            (selected === "auto" && !status.autoModeAvailable) ||
            (selected === "always-approve" && !status.alwaysApproveAvailable)
          ) {
            setHomeMode("ask");
          }
        }
      })
      .catch(() => {
        /* 读不到就用默认 ask */
      });
    return () => {
      if (requestRef.current === request) requestRef.current += 1;
    };
  }, [sessionId, setHomeMode, setStatus]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) {
        setOpen(false);
        setConfirmingAlways(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  useEffect(() => {
    if (confirmingAlways) confirmCancelRef.current?.focus();
  }, [confirmingAlways]);

  const cancelAlwaysConfirmation = useCallback(() => {
    setConfirmingAlways(false);
    requestAnimationFrame(() => alwaysOptionRef.current?.focus());
  }, []);

  const applySelection = useCallback(
    async (next: PermissionMode) => {
      const desiredMode = sessionId
        ? status?.configuredPermissionMode ?? mode
        : mode;
      if (
        next === desiredMode &&
        status?.runtimeSyncState !== "failed" &&
        status?.runtimeSyncState !== "syncing"
      ) {
        setOpen(false);
        setConfirmingAlways(false);
        return;
      }
      // An earlier capability read must not overwrite the result of the
      // user's newer write when it eventually resolves.
      if (sessionId) requestRef.current += 1;
      setBusy(true);
      try {
        if (!sessionId) {
          setHomeMode(next);
          setOpen(false);
          setConfirmingAlways(false);
          const selected = MODES.find((item) => item.id === next) ?? MODES[0];
          const label = selected.id === "always-approve" ? "始终允许" : selected.label;
          onToast?.(`本任务将使用“${label}”`);
          return;
        }
        const result = await permissionModeSet(sessionId, next);
        const normalizedStatus = permissionModeStatusFromEvent(result);
        if (normalizedStatus) setStatus(normalizedStatus);
        useSessionsStore.getState().upsert({
          sessionId,
          permissionMode: result.permissionMode ?? next,
        });
        setOpen(false);
        setConfirmingAlways(false);
        const selected = MODES.find((item) => item.id === next) ?? MODES[0];
        const label = selected.id === "always-approve" ? "始终允许" : selected.label;
        const remaining = result?.remainingPending ?? 0;
        const parts = [`当前任务已切换为“${label}”`];
        if (remaining > 0) parts.push(`当前 ${remaining} 个待审批操作仍需你确认`);
        onToast?.(parts.join("，"));
      } catch (e) {
        onToast?.(`权限模式切换失败：${String(e).replace(/^Error:\s*/, "")}`);
      } finally {
        setBusy(false);
      }
    },
    [mode, onToast, sessionId, setHomeMode, setStatus, status],
  );

  const select = useCallback((next: PermissionMode) => {
    if (next === "always-approve" && mode !== "always-approve") {
      setConfirmingAlways(true);
      return;
    }
    void applySelection(next);
  }, [applySelection, mode]);

  const current = MODES.find((m) => m.id === mode) ?? MODES[0];
  const autoUnavailable = status?.autoModeAvailable === false;
  const alwaysUnavailable = status?.alwaysApproveAvailable === false;
  const syncWarning = status?.runtimeSyncError ??
    (status?.runtimeSyncState === "syncing" ? "权限模式正在同步" : null);
  const modeDescription = (item: (typeof MODES)[number]) => {
    if (item.id === "auto" && autoUnavailable) {
      return status?.autoModeUnavailableReason ?? "自动模式当前不可用";
    }
    if (item.id === "always-approve" && alwaysUnavailable) {
      return status?.alwaysApproveUnavailableReason ?? "始终允许当前不可用";
    }
    return item.desc;
  };
  const modeDisabled = (item: (typeof MODES)[number]) =>
    busy ||
    (item.id === "auto" && autoUnavailable) ||
    (item.id === "always-approve" && alwaysUnavailable) ||
    Boolean(status?.locked);

  return (
    <div className="permission-picker" ref={popRef}>
      <button
        type="button"
        className="echo-composer-meta__btn"
        onClick={() => {
          if (open) setConfirmingAlways(false);
          setOpen((v) => !v);
        }}
        title={`权限模式 · ${modeDescription(current)}${syncWarning ? ` · ${syncWarning}` : ""}`}
      >
        <ShieldCheckIcon size="sm" />
        {triggerLabel ?? current.label}
        <ChevronDownIcon size="sm" />
      </button>
      {open && (
        <div className="permission-picker__popover permission-picker__popover--modes" role="menu">
          <div className="permission-picker__header">本任务权限</div>
          <div className="permission-picker__scope">仅影响当前任务，其他任务保持不变</div>
          {(syncWarning || status?.lockedReason) && (
            <div className="permission-picker__status" role="status">
              {syncWarning ?? status?.lockedReason}
              {status?.runtimeSyncState === "failed" ? "，选择目标模式可重试" : ""}
            </div>
          )}
          <div className="permission-picker__modes">
            {MODES.map((m) => (
              <button
                key={m.id}
                ref={m.id === "always-approve" ? alwaysOptionRef : undefined}
                type="button"
                className={
                  "permission-picker__mode" +
                  (m.id === mode ? " permission-picker__mode--active" : "")
                }
                onClick={() => select(m.id)}
                disabled={modeDisabled(m)}
                role="menuitemradio"
                aria-checked={m.id === mode}
              >
                <span className="permission-picker__mode-label">
                  {m.label}
                  {((m.id === "auto" && autoUnavailable) ||
                    (m.id === "always-approve" && alwaysUnavailable)) ? "（不可用）" : ""}
                </span>
                <span className="permission-picker__mode-desc">{modeDescription(m)}</span>
                {m.id === mode && <CheckIcon size="sm" className="permission-picker__mode-check" />}
              </button>
            ))}
          </div>
          {confirmingAlways && (
            <div
              className="permission-picker__confirm"
              role="alertdialog"
              aria-label="确认本任务始终允许"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  cancelAlwaysConfirmation();
                }
              }}
            >
              <strong>确认提高当前任务的权限？</strong>
              <span>后续工具调用可能修改文件或执行命令。已经弹出的待审批操作不会被自动批准。</span>
              <div className="permission-picker__confirm-actions">
                <button ref={confirmCancelRef} type="button" className="btn btn--ghost" disabled={busy} onClick={cancelAlwaysConfirmation}>取消</button>
                <button type="button" className="btn btn--danger" disabled={busy} onClick={() => void applySelection("always-approve")}>
                  {busy ? "正在切换…" : "仅当前任务始终允许"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
