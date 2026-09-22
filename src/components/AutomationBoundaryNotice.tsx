import { ShieldAlertIcon } from "@/foundation/components/Icon/icons";
import "./AutomationBoundaryNotice.css";

export type PermissionRole = "ask" | "auto" | "always-approve";

/**
 * 任务级权限模式为「始终允许」且操作电脑模式已激活时，
 * 在 Composer 顶部常驻显示一条轻提示，告知用户电脑操作仍会逐次确认。
 *
 * 不向操作网页模式提示——browser_click 等在 vendor 层已有统一确认，
 * 不属于本期"讲清楚"的目标范围。
 */
export function AutomationBoundaryNotice({
  role,
  computerActive,
}: {
  role: PermissionRole | null;
  computerActive: boolean;
}) {
  if (role !== "always-approve" || !computerActive) return null;
  return (
    <div className="automation-boundary-notice" role="note">
      <ShieldAlertIcon size="sm" />
      <span>
        本任务已设为「始终允许」，但操作电脑（点击 / 拖动 / 输入 / 按键）始终会逐次确认，避免误触敏感操作。
      </span>
    </div>
  );
}