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
import { usePermissionModeStore } from "@/stores/permission-mode-store";
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
  const setMode = usePermissionModeStore((state) => state.setMode);
  const [busy, setBusy] = useState(false);
  const [autoModeAvailable, setAutoModeAvailable] = useState<boolean | null>(null);
  const [autoModeUnavailableReason, setAutoModeUnavailableReason] = useState<string | null>(null);
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
        setAutoModeAvailable(status.autoModeAvailable);
        setAutoModeUnavailableReason(status.autoModeUnavailableReason ?? null);
        // Do not let a slow initial read overwrite a newer mode delivered by
        // the user's selection or the backend permission-mode event.
        if (usePermissionModeStore.getState().mode === modeAtStart) {
          setMode(status.permissionMode);
        }
      })
      .catch(() => {
        /* 读不到就用默认 ask */
      });
  }, [setMode]);

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
      if (next === mode) {
        setOpen(false);
        return;
      }
      setBusy(true);
      try {
        const result = await permissionModeSet(next);
        const appliedMode = result?.permissionMode ?? next;
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
        setMode(appliedMode);
        setOpen(false);
        const applied = MODES.find((item) => item.id === appliedMode) ?? MODES[0];
        const resolved = result?.resolvedPending ?? 0;
        const remaining = result?.remainingPending ?? 0;
        const runtimeUnconfirmed = Boolean(
          result?.agentRunning && !result.runtimeSynced && appliedMode !== "always-approve",
        );
        const parts = [
          runtimeUnconfirmed
            ? `已保存为“${applied.label}”`
            : `已切换为“${applied.label}”`,
        ];
        if (resolved > 0) parts.push(`并自动处理 ${resolved} 个等待授权操作`);
        if (appliedMode === "auto" && remaining > 0) {
          parts.push(`将应用于后续操作，当前 ${remaining} 个等待授权操作仍需你确认`);
        } else if (appliedMode === "always-approve" && remaining > 0) {
          parts.push(`另有 ${remaining} 个操作没有可自动允许选项，仍需你确认`);
        }
        if (result?.agentRunning && !result.runtimeSynced) {
          parts.push(
            appliedMode === "always-approve"
              ? "运行时未确认同步，桌面端仍会自动处理审批"
              : "运行中会话未确认切换，新建或重新打开会话后生效",
          );
        }
        onToast?.(parts.join("，"));
      } catch (e) {
        onToast?.(`权限模式切换失败：${String(e).replace(/^Error:\s*/, "")}`);
      } finally {
        setBusy(false);
      }
    },
    [mode, onToast, setMode],
  );

  const current = MODES.find((m) => m.id === mode) ?? MODES[0];
  const autoUnavailable = autoModeAvailable === false;
  const modeDescription = (item: (typeof MODES)[number]) =>
    item.id === "auto" && autoUnavailable
      ? (autoModeUnavailableReason ?? "自动模式当前不可用")
      : item.desc;

  return (
    <div className="permission-picker" ref={popRef}>
      <button
        type="button"
        className="echo-composer-meta__btn"
        onClick={() => setOpen((v) => !v)}
        title={`权限模式 · ${modeDescription(current)}`}
      >
        <ShieldCheckIcon size="sm" />
        {triggerLabel ?? current.label}
        <ChevronDownIcon size="sm" />
      </button>
      {open && (
        <div className="permission-picker__popover permission-picker__popover--modes" role="menu">
          <div className="permission-picker__header">权限模式</div>
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
                disabled={busy || (m.id === "auto" && autoUnavailable)}
                role="menuitemradio"
                aria-checked={m.id === mode}
              >
                <span className="permission-picker__mode-label">
                  {m.label}{m.id === "auto" && autoUnavailable ? "（不可用）" : ""}
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
