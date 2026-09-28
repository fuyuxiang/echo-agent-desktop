import { describe, expect, it } from "vitest";
import { buildProjectPrompt, projectPromptForTurn } from "../project-context";
import type { ProjectMeta } from "@/stores/projects-store";

const project: ProjectMeta = {
  id: "p1",
  name: "交付",
  createdAt: "2026-01-01T00:00:00Z",
  instructions: "先验收再发布",
  connectors: [{ id: "github", name: "GitHub" }],
  experts: [{ id: "/agents/reviewer.md", name: "reviewer" }],
  skills: [{ id: "/skills/pdf", name: "PDF" }],
  plans: [], tasks: [], assets: [], members: [], conversations: [],
};

describe("buildProjectPrompt", () => {
  it("将项目契约与真实运行时能力注入用户消息", () => {
    const result = buildProjectPrompt(project, "检查发布清单");
    expect(result).toContain("先验收再发布");
    expect(result).toContain("GitHub");
    expect(result).toContain("reviewer");
    expect(result).toContain("PDF");
    expect(result.endsWith("检查发布清单")).toBe(true);
  });

  it("空配置不伪造能力列表", () => {
    const result = buildProjectPrompt({ ...project, connectors: [], experts: [], skills: [] }, "hello");
    expect(result).not.toContain("[项目 MCP]");
    expect(result).not.toContain("[项目 Skill]");
  });

  it("移入的旧会话在下一轮补入项目契约，之后不重复补入", () => {
    const conversation = { sessionId: "old", title: "探索", createdAt: "2026-01-01", pendingProjectContext: true };
    const first = projectPromptForTurn(project, conversation, false, "继续讨论");
    expect(first.promptText).toContain("先验收再发布");
    expect(first.promptText.endsWith("继续讨论")).toBe(true);
    expect(first.consumedPendingContext).toBe(true);

    const later = projectPromptForTurn(project, { ...conversation, pendingProjectContext: false }, false, "下一步");
    expect(later).toEqual({ promptText: "下一步", consumedPendingContext: false });
  });
});
