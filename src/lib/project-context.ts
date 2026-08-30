import type { ProjectMeta, RefItem } from "@/stores/projects-store";

function names(items: RefItem[]): string {
  return items.map((item) => item.name).join("、");
}

/**
 * Build the hidden project contract sent with every newly-created project
 * session. The visible user bubble remains unchanged.
 */
export function buildProjectPrompt(project: ProjectMeta, userMessage: string): string {
  const context: string[] = [
    `<system-reminder>`,
    `你正在 EchoAgent 项目「${project.name}」中工作。以下是本会话的项目级契约：`,
  ];
  if (project.instructions?.trim()) {
    context.push(`\n[项目指令]\n${project.instructions.trim()}`);
  }
  if (project.experts.length > 0) {
    context.push(`\n[可用 Agent]\n${names(project.experts)}\n在适合的任务上优先委派给这些已安装 Agent。`);
  }
  if (project.skills.length > 0) {
    context.push(`\n[项目 Skill]\n${names(project.skills)}\n任务匹配时应优先遵循这些已启用 Skill。`);
  }
  if (project.connectors.length > 0) {
    context.push(`\n[项目 MCP]\n${names(project.connectors)}\n需要外部数据时优先使用这些已连接 MCP；不可伪造外部读写结果。`);
  }
  context.push(`\n如果所需能力当前不可用，必须明确说明阻塞，不得宣称已执行。`, `</system-reminder>`);
  return `${context.join("\n")}\n\n${userMessage}`;
}
