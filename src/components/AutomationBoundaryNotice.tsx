import { ShieldAlertIcon } from "@/foundation/components/Icon/icons";
import type { AutomationMode } from "@/lib/automation-client";
import "./AutomationBoundaryNotice.css";

export type PermissionRole = "ask" | "auto" | "always-approve";

/**
 * “始终允许”只覆盖常规 Agent 工具。网页和真实桌面的副作用
 * 仍受独立确认边界保护，因此两种自动化模式都必须说清楚。
 */
export function AutomationBoundaryNotice({
  role,
  automationMode,
}: {
  role: PermissionRole | null;
  automationMode: AutomationMode;
}) {
  if (role !== "always-approve" || automationMode === "default") return null;
  const target = automationMode === "computer_use" ? "操作电脑" : "操作网页";
  return (
    <div className="automation-boundary-notice" role="note">
      <ShieldAlertIcon size="sm" />
      <span>
        “始终允许”仅适用于常规工具；{target}中可能产生副作用的步骤仍会在执行前逐次确认。
      </span>
    </div>
  );
}
