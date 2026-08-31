import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  skillsList: vi.fn(),
  orgSetSkillPreference: vi.fn(),
  listenOrgSkillsChanged: vi.fn(),
  orgSession: vi.fn(),
  orgListScopes: vi.fn(),
  orgSubmitSkill: vi.fn(),
}));

vi.mock("@/lib/agent-client", () => ({
  skillsList: mocks.skillsList,
  skillsRemove: vi.fn(),
  skillsToggle: vi.fn(),
  skillsUninstallPackage: vi.fn(),
}));
vi.mock("@/lib/org-client", () => ({
  orgSetSkillPreference: mocks.orgSetSkillPreference,
  listenOrgSkillsChanged: mocks.listenOrgSkillsChanged,
  orgSession: mocks.orgSession,
  orgListScopes: mocks.orgListScopes,
  orgSubmitSkill: mocks.orgSubmitSkill,
}));
vi.mock("../experts-panel/skills/SkillCatalogCard", () => ({ SkillCatalogCard: () => null }));
vi.mock("../experts-panel/skills/SkillDetailModal", () => ({ SkillDetailModal: () => null }));
vi.mock("../experts-panel/skills/ImportSkillModal", () => ({ ImportSkillModal: () => null }));

import { SkillsTab } from "../experts-panel/skills/SkillsTab";

function organizationSkill(mandatory: boolean) {
  return {
    name: mandatory ? "security-policy" : "weekly-report",
    displayName: mandatory ? "安全规范" : "组织周报",
    description: mandatory ? "执行组织安全规范" : "生成团队周报",
    scope: "server",
    enabled: true,
    path: `/tmp/skills/organization/${mandatory ? "security" : "weekly"}/SKILL.md`,
    version: "1.2.0",
    orgManaged: true,
    orgSkillId: mandatory ? "skill-security" : "skill-weekly",
    orgVersionId: "version-1",
    orgScopeKind: mandatory ? "org" : "team",
    orgMandatory: mandatory,
    orgAllowPersonalOverride: !mandatory,
  };
}

describe("专家技能页的组织 Skill 集成", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.skillsList.mockResolvedValue([
      organizationSkill(true),
      organizationSkill(false),
      {
        name: "local-analysis",
        displayName: "本地分析",
        description: "本地用户技能",
        scope: "user",
        enabled: true,
        path: "/tmp/skills/local-analysis/SKILL.md",
      },
    ]);
    mocks.orgSetSkillPreference.mockResolvedValue({ skillId: "skill-weekly", enabled: false });
    mocks.listenOrgSkillsChanged.mockResolvedValue(vi.fn());
    mocks.orgSession.mockResolvedValue({
      loggedIn: true,
      bootstrap: { policy: { allowSkillSubmission: true } },
    });
    mocks.orgListScopes.mockResolvedValue([
      { id: "personal", kind: "personal", name: "我的空间" },
      { id: "team-1", kind: "team", name: "研发团队" },
    ]);
    mocks.orgSubmitSkill.mockResolvedValue({
      submissionId: "submission-1",
      skillId: "shared-1",
      version: "1.0.0",
      state: "pending",
    });
  });

  it("技能页直接读取全局目录且不再要求选择来源", async () => {
    render(<SkillsTab pills={<span>页签</span>} />);

    expect(await screen.findByText("安全规范")).toBeInTheDocument();
    expect(screen.getByText("用户全局技能 · ~/.echo-agent/skills")).toBeInTheDocument();
    expect(screen.queryByText("选择来源目录")).not.toBeInTheDocument();
    expect(mocks.skillsList).toHaveBeenCalled();
    expect(screen.getByText("组织周报")).toBeInTheDocument();
    expect(screen.getByText("全组织共享")).toBeInTheDocument();
    expect(screen.getByText("团队共享")).toBeInTheDocument();
    expect(screen.getAllByText("组织托管")).toHaveLength(2);
    expect(screen.getAllByText("v1.2.0")).toHaveLength(2);
  });

  it("组织强制 Skill 不可停用，可选 Skill 通过服务器偏好同步", async () => {
    render(<SkillsTab pills={<span>页签</span>} />);
    await screen.findByText("安全规范");

    expect(screen.getByRole("checkbox", { name: "卸载安全规范" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "卸载组织周报" }));

    await waitFor(() => expect(mocks.orgSetSkillPreference)
      .toHaveBeenCalledWith("skill-weekly", false));
  });

  it("本地 Skill 可直接选择组织范围并打包上传", async () => {
    render(<SkillsTab pills={<span>页签</span>} />);
    fireEvent.click(await screen.findByRole("button", { name: "上传本地分析到组织" }));

    expect(await screen.findByRole("heading", { name: "上传到组织" })).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toHaveValue("team-1");
    fireEvent.click(screen.getByRole("button", { name: "提交分享" }));

    await waitFor(() => expect(mocks.orgSubmitSkill).toHaveBeenCalledWith(
      "/tmp/skills/local-analysis/SKILL.md",
      "team-1",
    ));
  });
});
