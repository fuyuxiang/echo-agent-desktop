import { ShieldAlertIcon } from "@/foundation/components/Icon/icons";
import type { AutomationMode } from "@/lib/automation-client";
import { COMPUTER_EXECUTION_NOTICE, BROWSER_CONFIRMATION_NOTICE } from "@/lib/automation-policy";

export type PermissionRole = "ask" | "auto" | "always-approve";

/**
 * 常规工具权限与明确电脑任务授权是独立的边界。
 */
export function AutomationBoundaryNotice({
  role,
  automationMode,
}: {
  role: PermissionRole | null;
  automationMode: AutomationMode;
}) {
  if (role !== "always-approve" || automationMode === "default") return null;
  const boundary = automationMode === "computer_use" ? COMPUTER_EXECUTION_NOTICE : BROWSER_CONFIRMATION_NOTICE;
  return (
    <div className="automation-boundary-notice" role="note">
      <ShieldAlertIcon size="sm" />
      <span>
        “本任务免审批”仅适用于常规工具；{boundary}。
      </span>
    </div>
  );
}
