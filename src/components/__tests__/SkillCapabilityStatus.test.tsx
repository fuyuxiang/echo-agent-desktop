import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { SkillCapabilityReport, SkillCapabilityState } from "@/lib/types";
import { SKILL_CAPABILITY_PRESENTATION } from "@/lib/skill-capability";
import { SkillCapabilityStatus } from "../experts-panel/skills/SkillCapabilityStatus";

function report(state: SkillCapabilityState): SkillCapabilityReport {
  return {
    declared: state !== "instruction_only",
    state,
    ready: state === "instruction_only" || state === "ready",
    capabilities: [],
    checks: [],
  };
}

describe("SkillCapabilityStatus", () => {
  it.each(Object.keys(SKILL_CAPABILITY_PRESENTATION) as SkillCapabilityState[])(
    "renders the %s state with its shared label and guidance",
    (state) => {
      const presentation = SKILL_CAPABILITY_PRESENTATION[state];
      const { unmount } = render(<SkillCapabilityStatus report={report(state)} />);
      expect(screen.getByText(presentation.label)).toBeInTheDocument();
      expect(screen.getByText(presentation.help)).toBeInTheDocument();
      unmount();
    },
  );

  it("distinguishes a missing connector from an account awaiting authorization", () => {
    const missing: SkillCapabilityReport = {
      declared: true,
      state: "missing_dependencies",
      ready: false,
      capabilities: ["notion.page.create"],
      checks: [{
        kind: "connector",
        key: "notion",
        status: "missing",
        message: "Required connector Notion is not installed",
      }],
      manifest: {
        schemaVersion: 1,
        capabilities: ["notion.page.create"],
        requirements: {
          commands: [],
          connectors: [{ id: "notion", label: "Notion", accountRequired: true }],
          osPermissions: [],
        },
        permissions: { filesystem: "none", network: [], externalActions: [] },
        artifacts: [],
      },
    };
    render(<SkillCapabilityStatus report={missing} />);
    expect(screen.getByText("缺少依赖")).toBeInTheDocument();
    expect(screen.getByText("未安装连接器：Notion")).toBeInTheDocument();
  });
});
