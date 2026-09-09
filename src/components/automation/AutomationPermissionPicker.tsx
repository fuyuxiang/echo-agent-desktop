/**
 * AutomationPermissionPicker — 执行权限选择（完全访问权限 / 默认权限）。
 *
 * 复刻 EchoAgent automation-permission-picker.tsx：
 * 提示词工具条上的 chip 触发器（警告/盾牌图标 + 文案 + ⇕），
 * 下拉项带勾选列 + 图标 + 标题/描述。
 */
import { useEffect, useRef, useState } from "react";
import {
  CheckIcon,
  ChevronsUpDownIcon,
  ShieldCheckIcon,
  WarningOutlineIcon,
} from "@/foundation/components/Icon/icons";
import type { AutomationPermissionMode } from "@/lib/types";
import { usePermissionModeStore } from "@/stores/permission-mode-store";

export function AutomationPermissionPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: AutomationPermissionMode;
  onChange: (mode: AutomationPermissionMode) => void;
  disabled?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const permissionStatus = usePermissionModeStore((state) => state.capabilityStatus);

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setIsOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  const isFullAccess = value === "fullAccess";
  const fullAccessUnavailable = permissionStatus?.alwaysApproveAvailable === false;
  const fullAccessReason = permissionStatus?.alwaysApproveUnavailableReason ??
    "完全访问权限已被本机要求或组织策略禁用";
  const select = (mode: AutomationPermissionMode) => {
    if (mode === "fullAccess" && fullAccessUnavailable) return;
    onChange(mode);
    setIsOpen(false);
  };

  return (
    <div className="automation-permission-picker" ref={containerRef}>
      <button
        type="button"
        className={`automation-permission-picker__trigger ${isFullAccess ? "automation-permission-picker__trigger--warning" : "automation-permission-picker__trigger--safe"}`}
        disabled={disabled}
        onClick={() => setIsOpen((v) => !v)}
        title={isFullAccess && fullAccessUnavailable ? fullAccessReason : undefined}
      >
        {isFullAccess ? <WarningOutlineIcon size="sm" /> : <ShieldCheckIcon size="sm" />}
        <span className="automation-permission-picker__label">
          {isFullAccess ? "完全访问权限" : "默认权限"}
        </span>
        <span className="automation-permission-picker__caret">
          <ChevronsUpDownIcon size="sm" />
        </span>
      </button>
      {isOpen && (
        <div className="automation-permission-picker__dropdown" role="menu">
          <div
            className={`automation-permission-picker__item${isFullAccess ? " automation-permission-picker__item--selected" : ""}${fullAccessUnavailable ? " automation-permission-picker__item--disabled" : ""}`}
            onClick={() => select("fullAccess")}
            role="menuitemradio"
            aria-checked={isFullAccess}
            tabIndex={fullAccessUnavailable ? -1 : 0}
            aria-disabled={fullAccessUnavailable}
            onKeyDown={(event) => {
              if ((event.key === "Enter" || event.key === " ") && !fullAccessUnavailable) {
                select("fullAccess");
              }
            }}
          >
            <span className="automation-permission-picker__check-col">
              {isFullAccess && <CheckIcon size="md" />}
            </span>
            <span className="automation-permission-picker__icon-col">
              <WarningOutlineIcon size="md" />
            </span>
            <div className="automation-permission-picker__option">
              <span className="automation-permission-picker__option-title">
                完全访问权限{fullAccessUnavailable ? "（不可用）" : ""}
              </span>
              <span className="automation-permission-picker__option-desc">
                {fullAccessUnavailable
                  ? fullAccessReason
                  : "允许 AI 在无人值守任务中自动执行操作，可能涉及敏感数据或文件修改，仅在信任任务时使用，用户可随时恢复默认权限。"}
              </span>
            </div>
          </div>
          <div
            className={`automation-permission-picker__item automation-permission-picker__item--divider${!isFullAccess ? " automation-permission-picker__item--selected" : ""}`}
            onClick={() => select("default")}
            role="menuitemradio"
            aria-checked={!isFullAccess}
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                select("default");
              }
            }}
          >
            <span className="automation-permission-picker__check-col">
              {!isFullAccess && <CheckIcon size="md" />}
            </span>
            <span className="automation-permission-picker__icon-col">
              <ShieldCheckIcon size="md" />
            </span>
            <div className="automation-permission-picker__option">
              <span className="automation-permission-picker__option-title">
                默认权限
                <span className="automation-permission-picker__option-recommend">（推荐）</span>
              </span>
              <span className="automation-permission-picker__option-desc">
                敏感操作需用户确认；无人值守时任务会安全地停在等待状态，适合绝大多数任务。
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
