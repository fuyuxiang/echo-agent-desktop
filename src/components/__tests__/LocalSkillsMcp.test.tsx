import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  install: vi.fn(),
  mcpList: vi.fn(),
  mcpSetup: vi.fn(),
  mcpToggleTool: vi.fn(),
  openDialog: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.openDialog }));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: { getState: () => ({ sessionId: "session-1" }) },
}));
vi.mock("@/lib/ensure-session", () => ({ ensureSession: vi.fn(async () => "session-1") }));
vi.mock("@/lib/agent-client", () => ({
  skillsInspectPackage: mocks.inspect,
  skillsInstallPackage: mocks.install,
  mcpList: mocks.mcpList,
  mcpSetup: mocks.mcpSetup,
  mcpToggleTool: mocks.mcpToggleTool,
  mcpDelete: vi.fn(),
  mcpToggle: vi.fn(),
  onMcpStatusEvent: vi.fn(async () => () => {}),
  mcpConfigPath: vi.fn(),
  mcpConfigRead: vi.fn(),
  mcpConfigSave: vi.fn(),
}));

import { ImportSkillModal } from "../experts-panel/skills/ImportSkillModal";
import { McpModal } from "../experts-panel/connectors/McpModal";

describe("本地 Skills / MCP 完整流程", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.openDialog.mockResolvedValue("/tmp/demo-skill");
    mocks.inspect.mockResolvedValue({
      sourcePath: "/tmp/demo-skill",
      name: "demo-skill",
      description: "Demo",
      version: "1.0.0",
      fileCount: 2,
      totalBytes: 100,
      riskLevel: "medium",
      findings: [{
        level: "medium",
        code: "executable-script",
        message: "包含可执行脚本，安装前应审查源码",
        path: "scripts/run.sh",
      }],
      warnings: [],
      sourceHash: "a".repeat(64),
      alreadyInstalled: false,
    });
    mocks.install.mockResolvedValue({
      installedPath: "/tmp/managed/demo-skill",
      updated: false,
      inspection: { name: "demo-skill" },
    });
    mocks.mcpList.mockResolvedValue([]);
  });

  it("中风险 Skill 先展示报告，不自动安装，确认后才提交", async () => {
    render(<ImportSkillModal onClose={vi.fn()} />);
    fireEvent.click(screen.getByText(/拖入 Markdown/).closest(".sk-drop")!);

    expect(await screen.findByText("中风险")).toBeInTheDocument();
    expect(screen.getByText("包含可执行脚本，安装前应审查源码")).toBeInTheDocument();
    expect(mocks.install).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "安装技能" }));
    await waitFor(() => expect(mocks.install).toHaveBeenCalledWith("/tmp/demo-skill", false));
  });

  it("MCP Setup 与逐工具开关走活动会话", async () => {
    mocks.mcpList.mockResolvedValue([{
      name: "demo",
      displayName: "Demo MCP",
      transport: "stdio",
      target: "demo-mcp",
      enabled: true,
      source: "local",
      status: "setuprequired",
      live: true,
      authRequired: false,
      setupRequired: true,
      setup: {
        fields: [{
          id: "region",
          label: "Region",
          type: "select",
          required: true,
          options: [{ label: "US", value: "us" }],
        }],
        variables: {},
      },
      setupValues: {},
      tools: [{ name: "read_file", displayName: "Read file", enabled: true }],
      args: [],
      env: {},
      editable: true,
    }]);
    render(<McpModal onClose={vi.fn()} />);

    fireEvent.click(await screen.findByText("Demo MCP"));
    fireEvent.change(screen.getByLabelText(/Region/), { target: { value: "us" } });
    fireEvent.click(screen.getByRole("button", { name: "应用并启动" }));
    await waitFor(() => expect(mocks.mcpSetup).toHaveBeenCalledWith(
      "session-1", "demo", { region: "us" },
    ));

    const tool = screen.getByText("Read file").closest<HTMLElement>(".mcp-tool")!;
    fireEvent.click(within(tool).getByRole("checkbox"));
    await waitFor(() => expect(mocks.mcpToggleTool).toHaveBeenCalledWith(
      "session-1", "demo", "read_file", false,
    ));
  });
});
