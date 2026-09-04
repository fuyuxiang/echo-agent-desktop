import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ActivityTab, AssetsTab, PlanTab, TaskTab } from "../project-tabs";
import { ProjectDetailView } from "../ProjectDetailView";
import { useProjectsStore, type ProjectMeta } from "@/stores/projects-store";
import { filesystemPickFiles, projectAssetsImport } from "@/lib/agent-client";

vi.mock("@/lib/agent-client", () => ({
  projectsSave: vi.fn().mockResolvedValue(undefined),
  filesystemPickFiles: vi.fn().mockResolvedValue([]),
  openLocalPath: vi.fn(),
  projectAssetMakeDir: vi.fn(),
  projectAssetRemove: vi.fn(),
  projectAssetsImport: vi.fn(),
}));

const project: ProjectMeta = {
  id: "p1",
  name: "发布项目",
  cwd: "/workspace",
  createdAt: new Date().toISOString(),
  connectors: [], experts: [], skills: [], assets: [], members: [],
  conversations: [{ sessionId: "existing", title: "历史会话", createdAt: new Date().toISOString() }],
  plans: [{ id: "plan1", title: "完成发布检查", status: "pending" }],
  tasks: [{ id: "task1", title: "修复阻断问题", scope: "personal", source: "manual", status: "pending" }],
};

describe("项目计划/任务与 Agent 会话闭环", () => {
  beforeEach(() => useProjectsStore.setState({ projects: [structuredClone(project)] }));

  it("计划交给 Agent 后进入进行中并关联会话", async () => {
    const onRun = vi.fn().mockResolvedValue("session-plan");
    render(<PlanTab projectId="p1" onRun={onRun} />);
    fireEvent.click(screen.getByRole("button", { name: "交给 Agent" }));
    await waitFor(() => expect(onRun).toHaveBeenCalledWith(expect.stringContaining("完成发布检查")));
    await waitFor(() => expect(useProjectsStore.getState().projects[0].plans[0]).toMatchObject({
      status: "in_progress", sessionId: "session-plan",
    }));
  });

  it("任务支持 Agent 执行和人工状态流转", async () => {
    const onRun = vi.fn().mockResolvedValue("session-task");
    render(<TaskTab projectId="p1" onRun={onRun} />);
    fireEvent.click(screen.getByRole("button", { name: "交给 Agent" }));
    await waitFor(() => expect(useProjectsStore.getState().projects[0].tasks[0].sessionId).toBe("session-task"));
    fireEvent.change(screen.getByRole("combobox", { name: /调整任务状态/ }), { target: { value: "completed" } });
    expect(useProjectsStore.getState().projects[0].tasks[0].status).toBe("completed");
  });

  it("新建待办使用应用内输入对话框", async () => {
    render(<PlanTab projectId="p1" />);
    fireEvent.click(screen.getByRole("button", { name: "+ 新建待办" }));
    const dialog = screen.getByRole("dialog", { name: "新建待办" });
    fireEvent.change(screen.getByRole("textbox", { name: /待办标题/ }), { target: { value: "  发布验收  " } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "新建待办" })).toBeNull());
    expect(dialog).not.toBeInTheDocument();
    expect(useProjectsStore.getState().projects[0].plans).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "发布验收", status: "pending" }),
    ]));
  });

  it("删除任务需确认，取消不变更项目", () => {
    render(<TaskTab projectId="p1" />);
    const remove = screen.getByRole("button", { name: "删除任务 修复阻断问题" });
    fireEvent.click(remove);
    const dialog = screen.getByRole("alertdialog", { name: "删除任务“修复阻断问题”？" });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(dialog).not.toBeInTheDocument();
    expect(useProjectsStore.getState().projects[0].tasks).toHaveLength(1);
  });

  it("项目动态可直接打开真实历史会话", () => {
    const onOpenSession = vi.fn();
    render(<ActivityTab projectId="p1" onOpenSession={onOpenSession} />);
    fireEvent.click(screen.getByText("历史会话"));
    expect(onOpenSession).toHaveBeenCalledWith("existing", "/workspace");
  });

  it("归档会话不会在项目动态中伪装成可打开项", () => {
    useProjectsStore.setState({
      projects: [{
        ...structuredClone(project),
        conversations: [
          ...project.conversations,
          { sessionId: "archived", title: "已归档", createdAt: new Date().toISOString(), archived: true },
        ],
      }],
    });
    render(<ActivityTab projectId="p1" onOpenSession={vi.fn()} />);
    expect(screen.queryByText("已归档")).toBeNull();
    expect(screen.getByText(/1 个已归档/)).toBeInTheDocument();
  });

  it("归档和删除会话同步所有项目引用", () => {
    useProjectsStore.setState({
      projects: [{
        ...structuredClone(project),
        plans: [{ ...project.plans[0], sessionId: "existing" }],
        tasks: [{ ...project.tasks[0], sessionId: "existing" }],
      }],
    });
    useProjectsStore.getState().setSessionArchived("existing", true);
    let updated = useProjectsStore.getState().projects[0];
    expect(updated.conversations[0].archived).toBe(true);
    expect(updated.plans[0].sessionArchived).toBe(true);
    expect(updated.tasks[0].sessionArchived).toBe(true);

    useProjectsStore.getState().removeSessionReferences("existing");
    updated = useProjectsStore.getState().projects[0];
    expect(updated.conversations).toHaveLength(0);
    expect(updated.plans[0].sessionId).toBeUndefined();
    expect(updated.tasks[0].sessionId).toBeUndefined();
  });

  it("批量导入资产时防止重复提交并一次更新项目", async () => {
    vi.mocked(filesystemPickFiles).mockResolvedValueOnce(["/tmp/report.pdf"]);
    let finishImport!: (assets: Awaited<ReturnType<typeof projectAssetsImport>>) => void;
    vi.mocked(projectAssetsImport).mockReturnValueOnce(new Promise((resolve) => {
      finishImport = resolve;
    }));

    render(<AssetsTab projectId="p1" />);
    fireEvent.click(screen.getByRole("button", { name: "导入文件副本" }));

    await waitFor(() => expect(projectAssetsImport).toHaveBeenCalledWith("p1", ["/tmp/report.pdf"]));
    expect(screen.getByRole("button", { name: "导入中…" })).toBeDisabled();

    await act(async () => finishImport([{
      name: "report.pdf",
      path: "/private/project/report.pdf",
      kind: "file",
      ext: "PDF",
      sizeBytes: 12,
      updatedAt: new Date().toISOString(),
    }]));
    await waitFor(() => expect(screen.getByText("report.pdf")).toBeInTheDocument());
    expect(useProjectsStore.getState().projects[0].assets).toHaveLength(1);
    expect(screen.getByRole("button", { name: "删除资产 report.pdf" })).toBeInTheDocument();
  });

  it("项目消息未启动时保留草稿并给出可操作提示", async () => {
    const onStartConversation = vi.fn().mockResolvedValue(undefined);
    render(
      <ProjectDetailView
        project={project}
        onBack={vi.fn()}
        onStartConversation={onStartConversation}
        picker={{ options: { connectors: [], experts: [], skills: [] }, loading: false, error: null }}
      />,
    );
    const composer = screen.getByPlaceholderText("输入消息...");
    fireEvent.change(composer, { target: { value: "请生成发布清单" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("消息尚未发送"));
    expect(composer).toHaveValue("请生成发布清单");
  });

  it("项目指令在关闭配置时再持久化，避免每次按键写盘", () => {
    render(
      <ProjectDetailView
        project={project}
        onBack={vi.fn()}
        picker={{ options: { connectors: [], experts: [], skills: [] }, loading: false, error: null }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /指令/ }));
    const input = screen.getByPlaceholderText("设定项目背景与规范，让 AI 与你高效协作…");
    fireEvent.change(input, { target: { value: "只在完成时保存" } });
    expect(useProjectsStore.getState().projects[0].instructions).toBeUndefined();

    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    expect(useProjectsStore.getState().projects[0].instructions).toBe("只在完成时保存");
  });
});
