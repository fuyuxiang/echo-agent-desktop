/**
 * 权限模式选择器 - Composer meta 行的下拉
 *
 * 对应 EchoAgent 的 `[ui] permission_mode`,三档:
 *  - ask            审批模式:每次工具调用都弹确认
 *  - auto           自动模式:EchoAgent 的分类器自动批准安全操作
 *  - always-approve 始终允许:所有工具调用自动批准
 *
 * 切换会写入 config.toml(影响之后的启动),并通过
 * `echo.agent/yolo_mode_changed` 通知运行中的 agent 立即生效。
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
import { usePermissionStore } from "@/stores/permission-store";
import { useSessionsStore } from "@/stores/sessions-store";

const MODES: { id: PermissionMode; label: string; desc: string }[] = [
  {
    id: "ask",
    label: "审批模式",
    desc: "敏感操作逐次确认，读取与搜索等低风险操作直接执行",
  },
  {
    id: "auto",
    label: "自动模式",
    desc: "常规操作自动执行，高风险操作先阻止，必要时询问",
  },
  {
    id: "always-approve",
    label: "始终允许",
    desc: "在策略允许范围内自动批准工具调用",
  },
];

export function PermissionPicker({
  onToast,
  triggerLabel,
}: {
  onToast?: (msg: string) => void;
  /** 覆盖触发按钮文字（如本地助理页固定显示「默认权限」）；缺省显示当前模式名。 */
  triggerLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const mode = usePermissionModeStore((state) => state.mode);
  const status = usePermissionModeStore((state) => state.status);
  const setMode = usePermissionModeStore((state) => state.setMode);
  const setStatus = usePermissionModeStore((state) => state.setStatus);
  const [busy, setBusy] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const modeAtStart = usePermissionModeStore.getState().mode;
    permissionModeGet()
      .then((status) => {
        // Tolerate a renderer/native version skew during an in-place update.
        // The previous command returned only the mode string.
        if (typeof status === "string") {
          if (usePermissionModeStore.getState().mode === modeAtStart) {
            setMode(status as PermissionMode);
          }
          return;
        }
        // Do not let a slow initial read overwrite a newer mode delivered by
        // the user's selection or the backend permission-mode event.
        if (usePermissionModeStore.getState().mode === modeAtStart) {
          setStatus(status);
        }
      })
      .catch(() => {
        /* 读不到就用默认 ask */
      });
  }, [setMode, setStatus]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const select = useCallback(
    async (next: PermissionMode) => {
      const desiredMode = status?.configuredPermissionMode ?? mode;
      if (
        next === desiredMode &&
        status?.runtimeSyncState !== "failed" &&
        status?.runtimeSyncState !== "syncing"
      ) {
        setOpen(false);
        return;
      }
      setBusy(true);
      try {
        const result = await permissionModeSet(next);
        const normalizedStatus = permissionModeStatusFromEvent(result);
        if (normalizedStatus) setStatus(normalizedStatus);
        else setMode(result?.permissionMode ?? next);
        const appliedMode =
          normalizedStatus &&
          (normalizedStatus.runtimeSyncState === "failed" ||
            normalizedStatus.runtimeSyncState === "syncing") &&
          normalizedStatus.runtimeAppliedMode
            ? normalizedStatus.runtimeAppliedMode
            : (result?.permissionMode ?? next);
        // The backend also emits permission-closed events. Applying the command
        // result is an idempotent fallback for the tiny listener-registration
        // window during application startup.
        result?.resolvedPermissions?.forEach(({ requestId, sessionId }) => {
          usePermissionStore.getState().close(requestId, sessionId);
          const permissionState = usePermissionStore.getState();
          const sessionsState = useSessionsStore.getState();
          const session = sessionsState.independent.find(
            (entry) => entry.sessionId === sessionId,
          );
          if (
            (permissionState.queues[sessionId]?.length ?? 0) === 0 &&
            session?.status === "awaiting_permission"
          ) {
            sessionsState.upsert({
              sessionId,
              status: "working",
              updatedAt: new Date().toISOString(),
            });
          }
        });
        setOpen(false);
        const selected = MODES.find((item) => item.id === next) ?? MODES[0];
        const actual = MODES.find((item) => item.id === appliedMode) ?? MODES[0];
        const resolved = result?.resolvedPending ?? 0;
        const remaining = result?.remainingPending ?? 0;
        const runtimeUnconfirmed = Boolean(result?.agentRunning && !result.runtimeSynced);
        const parts = [
          runtimeUnconfirmed
            ? `已保存为“${selected.label}”`
            : `已切换为“${selected.label}”`,
        ];
        if (resolved > 0) parts.push(`并自动处理 ${resolved} 个等待授权操作`);
        if (next === "auto" && remaining > 0) {
          parts.push(`将应用于后续操作，当前 ${remaining} 个等待授权操作仍需你确认`);
        } else if (next === "always-approve" && remaining > 0) {
          parts.push(`另有 ${remaining} 个操作没有可自动允许选项，仍需你确认`);
        }
        if (result?.agentRunning && !result.runtimeSynced) {
          parts.push(`运行中会话仍为“${actual.label}”，请点击“${selected.label}”重试`);
        } else if (!result?.agentRunning && result?.runtimeSyncError) {
          parts.push("旧权限状态已安全停止，重启 Agent 后生效");
        }
        onToast?.(parts.join("，"));
      } catch (e) {
        onToast?.(`权限模式切换失败：${String(e).replace(/^Error:\s*/, "")}`);
      } finally {
        setBusy(false);
      }
    },
    [mode, onToast, setMode, setStatus, status],
  );

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
        onClick={() => setOpen((v) => !v)}
        title={`权限模式 · ${modeDescription(current)}${syncWarning ? ` · ${syncWarning}` : ""}`}
      >
        <ShieldCheckIcon size="sm" />
        {triggerLabel ?? current.label}
        <ChevronDownIcon size="sm" />
      </button>
      {open && (
        <div className="permission-picker__popover permission-picker__popover--modes" role="menu">
          <div className="permission-picker__header">权限模式</div>
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
        </div>
      )}
    </div>
  );
}
