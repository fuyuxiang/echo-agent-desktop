import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  inspectMany: vi.fn(),
  install: vi.fn(),
  mcpList: vi.fn(),
  mcpSetup: vi.fn(),
  mcpToggleTool: vi.fn(),
  mcpAuthTrigger: vi.fn(),
  pickFiles: vi.fn(),
  pickDirectory: vi.fn(),
  openUrl: vi.fn(),
}));

vi.mock("@/stores/session-store", () => {
  const state = { sessionId: "session-1" };
  const useSessionStore = Object.assign(
    (selector: (value: typeof state) => unknown) => selector(state),
    { getState: () => state },
  );
  return { useSessionStore };
});
vi.mock("@/lib/ensure-session", () => ({ ensureSession: vi.fn(async () => "session-1") }));
vi.mock("@/lib/agent-client", () => ({
  skillsInspectPackage: mocks.inspect,
  skillsInspectPackages: mocks.inspectMany,
  skillsInstallPackage: mocks.install,
  filesystemPickFiles: mocks.pickFiles,
  filesystemPickDirectory: mocks.pickDirectory,
  mcpList: mocks.mcpList,
  mcpSetup: mocks.mcpSetup,
  mcpToggleTool: mocks.mcpToggleTool,
  mcpAuthTrigger: mocks.mcpAuthTrigger,
  mcpDelete: vi.fn(),
  mcpToggle: vi.fn(),
  onMcpStatusEvent: vi.fn(async () => () => {}),
  openUrl: mocks.openUrl,
  mcpConfigPath: vi.fn(),
  mcpConfigRead: vi.fn(),
  mcpConfigSave: vi.fn(),
}));

import { ImportSkillModal } from "../experts-panel/skills/ImportSkillModal";
import { McpModal } from "../experts-panel/connectors/McpModal";
import { ConnectorsTab } from "../experts-panel/connectors/ConnectorsTab";

describe("本地 Skills / MCP 完整流程", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.pickFiles.mockResolvedValue(["/tmp/demo-skill"]);
    mocks.pickDirectory.mockResolvedValue("/tmp/demo-skill");
    const inspection = {
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
      capability: {
        declared: true,
        state: "configuration_required",
        ready: false,
        capabilities: ["notion.page.create"],
        checks: [{
          kind: "connector",
          key: "notion",
          status: "configuration_required",
          message: "Connect an account for Notion",
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
      },
      sourceHash: "a".repeat(64),
      alreadyInstalled: false,
    };
    mocks.inspect.mockResolvedValue(inspection);
    mocks.inspectMany.mockResolvedValue([{ label: "demo-skill", inspection }]);
    mocks.install.mockResolvedValue({
      installedPath: "/tmp/managed/demo-skill",
      updated: false,
      inspection: { name: "demo-skill" },
    });
    mocks.openUrl.mockResolvedValue(undefined);
    mocks.mcpList.mockResolvedValue([]);
  });

  it("中风险 Skill 先展示报告，不自动安装，确认后才提交", async () => {
    render(<ImportSkillModal onClose={vi.fn()} />);
    fireEvent.click(screen.getByText(/点击选择 Markdown/).closest(".sk-drop")!);

    expect(await screen.findByText("中风险")).toBeInTheDocument();
    expect(screen.getByText("包含可执行脚本，安装前应审查源码")).toBeInTheDocument();
    expect(screen.getByText("待连接/授权")).toBeInTheDocument();
    expect(screen.getByText("待连接账号：Notion")).toBeInTheDocument();
    expect(mocks.install).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "安装技能" }));
    await waitFor(() => expect(mocks.install).toHaveBeenCalledWith(
      "/tmp/demo-skill",
      "a".repeat(64),
      false,
    ));
  });

  it("低风险 Skill 默认也只检查，需要用户显式点击安装", async () => {
    const inspection = {
      sourcePath: "/tmp/demo-skill",
      name: "demo-skill",
      description: "Demo",
      version: "1.0.0",
      fileCount: 1,
      totalBytes: 32,
      riskLevel: "low",
      findings: [],
      warnings: [],
      sourceHash: "b".repeat(64),
      alreadyInstalled: false,
    };
    mocks.inspectMany.mockResolvedValueOnce([{ label: "demo-skill", inspection }]);
    render(<ImportSkillModal onClose={vi.fn()} />);

    expect(screen.getByRole("checkbox", { name: /低风险时自动安装/ })).not.toBeChecked();
    fireEvent.click(screen.getByText(/点击选择 Markdown/).closest(".sk-drop")!);

    expect(await screen.findByText("低风险")).toBeInTheDocument();
    expect(mocks.install).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "安装技能" }));
    await waitFor(() => expect(mocks.install).toHaveBeenCalledWith(
      "/tmp/demo-skill",
      "b".repeat(64),
      false,
    ));
  });

  it("待授权服务有实际授权入口，拒绝后可重试并刷新真实状态", async () => {
    const server = {
      name: "oauth-demo", displayName: "OAuth Demo", transport: "http", target: "https://mcp.example.com",
      enabled: true, source: "user", status: "needsauth", live: true, authRequired: true,
      setupRequired: false, setupValues: {}, tools: [], args: [], env: {}, editable: true,
    };
    mocks.mcpList.mockResolvedValue([server]);
    mocks.mcpAuthTrigger.mockResolvedValueOnce({ status: "failed", error: "用户拒绝授权" })
      .mockResolvedValueOnce({ status: "authenticated" });
    render(<McpModal onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "授权 MCP 服务 OAuth Demo" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("用户拒绝授权");
    expect(mocks.mcpAuthTrigger).toHaveBeenCalledWith("session-1", "oauth-demo");

    mocks.mcpList.mockResolvedValue([{ ...server, authRequired: false, status: "ready", tools: [{ name: "query", enabled: true }] }]);
    fireEvent.click(screen.getByRole("button", { name: "授权 MCP 服务 OAuth Demo" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "授权 MCP 服务 OAuth Demo" })).toBeNull());
    expect(screen.getByText("1 个工具")).toBeInTheDocument();
    expect(mocks.mcpList).toHaveBeenLastCalledWith("session-1", true);
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

  it("连接器页直接展示全局 MCP 管理，不再要求额外跳转", async () => {
    render(<ConnectorsTab pills={<span>连接器页签</span>} />);

    expect(await screen.findByText("还没有已配置的连接器")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "已配置连接器" })).toBeInTheDocument();
    expect(screen.queryByText("查看全局连接器")).not.toBeInTheDocument();
    expect(document.querySelector(".modal-overlay")).not.toBeInTheDocument();
  });
});
