import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ProjectDetailView } from "../ProjectDetailView";
import { useProjectsStore, type ProjectMeta } from "@/stores/projects-store";
import { useSessionsStore } from "@/stores/sessions-store";

vi.mock("@/lib/agent-client", () => ({
  projectsSave: vi.fn().mockResolvedValue(undefined),
  filesystemPickFiles: vi.fn().mockResolvedValue([]),
  openLocalPath: vi.fn(),
  projectAssetMakeDir: vi.fn(),
  projectAssetRemove: vi.fn(),
  projectAssetsImport: vi.fn(),
  discardAttachmentBlob: vi.fn().mockResolvedValue(undefined),
}));

const baseProject: ProjectMeta = {
  id: "p1",
  name: "发布项目",
  cwd: "/workspace",
  createdAt: new Date().toISOString(),
  connectors: [],
  experts: [],
  skills: [],
  assets: [],
  members: [],
  conversations: [],
  plans: [],
  tasks: [],
};

const models = [
  { id: "model-a", label: "模型 A" },
  { id: "model-b", label: "模型 B" },
];

const picker = {
  options: { connectors: [], experts: [], skills: [] },
  loading: false,
  error: null,
};

function resetStores(project: ProjectMeta = baseProject) {
  useProjectsStore.setState({ projects: [structuredClone(project)] });
  useSessionsStore.setState({ independent: [] });
}

describe("ProjectDetailView 项目 composer 接入首页 Composer", () => {
  it("header chip 显示项目名与 0 项降级文案", () => {
    resetStores();
    render(
      <ProjectDetailView
        project={baseProject}
        onBack={vi.fn()}
        onStartConversation={vi.fn()}
        models={models}
        defaultModelId="model-a"
        picker={picker}
      />,
    );
    const header = screen.getByRole("status", { name: /项目「发布项目」/ });
    expect(header.textContent).toContain("发布项目");
    // 无 experts / skills / connectors / instructions 时降级为「无」。
    expect(header.textContent).toContain("无");
    expect(header.querySelector(".pd-composer-header__count--active")).toBeNull();
  });

  it("header chip 在含项目指令但无 Agent/Skill/MCP 时显示「仅指令」", () => {
    resetStores({ ...baseProject, instructions: "只在完成时保存" });
    render(
      <ProjectDetailView
        project={{ ...baseProject, instructions: "只在完成时保存" }}
        onBack={vi.fn()}
        onStartConversation={vi.fn()}
        models={models}
        defaultModelId="model-a"
        picker={picker}
      />,
    );
    const header = screen.getByRole("status", { name: /注入项目指令/ });
    expect(header.textContent).toContain("仅指令");
    expect(header.textContent).not.toContain("Agent");
    expect(header.textContent).not.toContain("Skill");
    expect(header.textContent).not.toContain("MCP");
  });

  it("header chip 在含 Agent/Skill/MCP 时按计数 > 0 高亮并显示完整摘要", () => {
    resetStores({
      ...baseProject,
      experts: [{ id: "a1", name: "需求分析师" }],
      skills: [
        { id: "s1", name: "code-review" },
        { id: "s2", name: "release-notes" },
      ],
      connectors: [],
    });
    render(
      <ProjectDetailView
        project={{
          ...baseProject,
          experts: [{ id: "a1", name: "需求分析师" }],
          skills: [
            { id: "s1", name: "code-review" },
            { id: "s2", name: "release-notes" },
          ],
          connectors: [],
        }}
        onBack={vi.fn()}
        onStartConversation={vi.fn()}
        models={models}
        defaultModelId="model-a"
        picker={picker}
      />,
    );
    const header = screen.getByRole("status", { name: /注入 1 个 Agent、2 个 Skill、0 个 MCP/ });
    expect(header.textContent).toContain("1 Agent");
    expect(header.textContent).toContain("2 Skill");
    expect(header.textContent).toContain("0 MCP");
    // Agent/Skill > 0 高亮;MCP = 0 不高亮。
    const activeCounts = header.querySelectorAll(".pd-composer-header__count--active");
    expect(activeCounts.length).toBe(2);
  });

  it("模型列表为空 + defaultModelId 不可用时显示外置 alert + 前往设置模型按钮", () => {
    useProjectsStore.setState({
      projects: [{ ...structuredClone(baseProject), defaultModelId: "removed-model" }],
    });
    const onOpenModelSettings = vi.fn();
    render(
      <ProjectDetailView
        project={baseProject}
        onBack={vi.fn()}
        onStartConversation={vi.fn()}
        models={[]}
        picker={picker}
        onOpenModelSettings={onOpenModelSettings}
      />,
    );
    const alerts = screen.getAllByRole("alert");
    expect(
      alerts.some((node) => node.textContent?.includes("原项目模型")),
    ).toBe(true);
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "前往设置模型" }));
    expect(onOpenModelSettings).toHaveBeenCalledTimes(1);
  });

  it("Composer 模型列表为空时显示 setupHint 引导去设置模型", () => {
    resetStores();
    render(
      <ProjectDetailView
        project={baseProject}
        onBack={vi.fn()}
        onStartConversation={vi.fn()}
        models={[]}
        picker={picker}
        onOpenModelSettings={vi.fn()}
      />,
    );
    expect(screen.getByText("请先在「设置 → 模型」配置模型")).toBeInTheDocument();
  });

  it("切换 tab 时 Composer 实例不卸载,草稿保留", async () => {
    resetStores();
    render(
      <ProjectDetailView
        project={baseProject}
        onBack={vi.fn()}
        onStartConversation={vi.fn()}
        models={models}
        defaultModelId="model-a"
        picker={picker}
      />,
    );
    const composer = screen.getByPlaceholderText(/Shift\+Enter/);
    fireEvent.change(composer, { target: { value: "草稿 A" } });
    expect(composer).toHaveValue("草稿 A");

    // 切到计划 tab 再切回活动 tab。
    fireEvent.click(screen.getByRole("button", { name: "工作项" }));
    expect(composer).toHaveValue("草稿 A");
    fireEvent.click(screen.getByRole("button", { name: "动态" }));
    expect(composer).toHaveValue("草稿 A");
  });

  it("附件由 Composer 透传到 onStartConversation 第 4 参", async () => {
    resetStores();
    const onStartConversation = vi.fn().mockResolvedValue("session-1");
    render(
      <ProjectDetailView
        project={baseProject}
        onBack={vi.fn()}
        onStartConversation={onStartConversation}
        models={models}
        defaultModelId="model-a"
        picker={picker}
      />,
    );
    const composer = screen.getByPlaceholderText(/Shift\+Enter/);
    fireEvent.change(composer, { target: { value: "请分析附件" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(onStartConversation).toHaveBeenCalled());
    // 第 4 参 attachments 一定存在(可能为 []),且只接收 4 参。
    const calls = onStartConversation.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]).toHaveLength(4);
    expect(calls[0][0]).toBe("p1");
    expect(calls[0][1]).toBe("请分析附件");
    expect(calls[0][2]).toBe("model-a");
    expect(Array.isArray(calls[0][3])).toBe(true);
  });

  it("onStartConversation 抛错时显示发送失败 alert 并保留输入", async () => {
    resetStores();
    const onStartConversation = vi.fn().mockRejectedValue(new Error("Network down"));
    render(
      <ProjectDetailView
        project={baseProject}
        onBack={vi.fn()}
        onStartConversation={onStartConversation}
        models={models}
        defaultModelId="model-a"
        picker={picker}
      />,
    );
    const composer = screen.getByPlaceholderText(/Shift\+Enter/);
    fireEvent.change(composer, { target: { value: "测试抛错" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "发送" }));
    });

    await waitFor(() => {
      const alerts = screen.getAllByRole("alert");
      expect(alerts.some((node) => node.textContent?.includes("Network down"))).toBe(true);
    });
    expect(composer).toHaveValue("测试抛错");
  });
});
