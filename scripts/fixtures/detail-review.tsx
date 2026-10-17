import { useState } from "react";
import { UploadSkillModal } from "../../src/components/experts-panel/skills/UploadSkillModal";
import { KnowledgePicker } from "../../src/components/KnowledgePicker";

const description = "帮助梳理工作目标、检查执行过程并整理可继续使用的交付结果。支持长内容阅读、明确的操作反馈和相关配置查看。".repeat(15);
export default function DetailReview() {
  const variant = new URLSearchParams(location.search).get("detailVariant") ?? "upload";
  const [open, setOpen] = useState(true);
  if (!open) return <button onClick={() => setOpen(true)}>重新打开</button>;
  if (variant === "knowledge") return <div style={{ padding: 30, height: "100%", overflow: "hidden" }}><KnowledgePicker onManage={() => {}} onOpenOrganization={() => {}} /></div>;
  if (variant === "upload") return <UploadSkillModal skill={{ name: "界面与交互质量评审技能", path: "/review/skills/ui-review/SKILL.md", source: "user", description: description }} onClose={() => setOpen(false)} />;
  return null;
}
