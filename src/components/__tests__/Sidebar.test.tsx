import { beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Sidebar } from "../Sidebar";
import { useSessionsStore } from "@/stores/sessions-store";
import { useProjectsStore } from "@/stores/projects-store";
import { resetOrgSessionMirror, useOrgSessionStore } from "@/stores/org-session-store";

vi.mock("@/lib/agent-client", () => ({
  agentRenameSession: vi.fn().mockResolvedValue(undefined),
  agentDeleteSession: vi.fn().mockResolvedValue(undefined),
  agentSetSessionPinned: vi.fn((_id: string, pinned: boolean) => Promise.resolve(pinned)),
  agentSetSessionArchived: vi.fn((_id: string, archived: boolean) => Promise.resolve(archived)),
  projectsLoad: vi.fn().mockResolvedValue([]),
  projectsSave: vi.fn().mockResolvedValue(undefined),
}));

const base = {
  onNewSession: vi.fn(),
  onSelect: vi.fn(),
  onNavigate: vi.fn(),
  onOpenSettings: vi.fn(),
  onToggleCollapse: vi.fn(),
  onOpenSearch: vi.fn(),
  onPlaceholder: vi.fn(),
  activeNav: "新建任务",
};

describe("Sidebar", () => {
  beforeEach(() => {
    resetOrgSessionMirror();
    useSessionsStore.setState({
      independent: [],
      workspaces: [],
      tasksOpen: true,
      projectsOpen: true,
      homeCwd: "/home",
      currentSessionId: null,
      loading: false,
      error: null,
      query: "",
      filterStatus: null,
      filterDate: null,
      filterArchived: false,
      pendingSessionPatches: {},
      drafts: {},
    });
    useProjectsStore.setState({
      projects: [],
      activeProjectId: null,
      persisting: false,
      persistError: null,
    });
  });

  it("渲染导航项", () => {
    render(<Sidebar {...base} />);
    for (const label of ["新建任务", "项目", "专家·技能·连接器", "自动化", "更多"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.queryByText("助理")).not.toBeInTheDocument();
  });

  it("点击占位导航触发 onNavigate", () => {
    const onNavigate = vi.fn();
    render(<Sidebar {...base} onNavigate={onNavigate} />);
    fireEvent.click(screen.getByText("项目"));
    expect(onNavigate).toHaveBeenCalledWith("项目");
  });

  it("渲染会话列表并可选中", () => {
    const onSelect = vi.fn();
    // cwd-less session ⇒ 任务 group (independent). onSelect now also receives cwd.
    useSessionsStore.getState().setIndependent([{ sessionId: "s1", title: "测试会话", cwd: "" } as any]);
    render(<Sidebar {...base} onSelect={onSelect} />);
    fireEvent.click(screen.getByText("测试会话"));
    expect(onSelect).toHaveBeenCalledWith("s1", "");
  });

  it("搜索按钮触发 onOpenSearch,设置按钮触发 onOpenSettings", () => {
    const onOpenSearch = vi.fn();
    const onOpenSettings = vi.fn();
    render(
      <Sidebar {...base} onOpenSearch={onOpenSearch} onOpenSettings={onOpenSettings} />
    );
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    expect(onOpenSearch).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it("通知与用户入口走各自的真实路由", () => {
    const onPlaceholder = vi.fn();
    const onOpenSettings = vi.fn();
    render(<Sidebar {...base} onPlaceholder={onPlaceholder} onOpenSettings={onOpenSettings} />);
    fireEvent.click(screen.getByRole("button", { name: "通知" }));
    fireEvent.click(screen.getByRole("button", { name: "本地用户" }));
    expect(onPlaceholder).toHaveBeenNthCalledWith(1, "通知");
    expect(onPlaceholder).toHaveBeenNthCalledWith(2, "用户中心");
    expect(onOpenSettings).not.toHaveBeenCalled();
  });

  it("左下角本地用户与操作按钮保持同一行", () => {
    render(<Sidebar {...base} />);
    const user = screen.getByRole("button", { name: "本地用户" });
    const footer = user.closest(".sidebar__footer");

    expect(user.querySelector(".sidebar__user-label")).toHaveTextContent("本地用户");
    expect(footer?.querySelector(".sidebar__logo-spacer")).toBeNull();
    expect(footer?.children).toHaveLength(3);
  });

  it("登录组织后左下角显示组织用户名", () => {
    useOrgSessionStore.getState().setSession({
      loggedIn: true,
      serverUrl: "https://memory.example.com",
      user: {
        id: "u1",
        username: "alice",
        displayName: "Alice Zhang",
        role: "member",
        clearance: 1,
      },
    });

    render(<Sidebar {...base} />);

    const user = screen.getByRole("button", { name: "Alice Zhang" });
    expect(user).toHaveTextContent("Alice Zhang");
    expect(user).toHaveAttribute("title", "Alice Zhang · https://memory.example.com");
  });

  it("收起侧边栏按钮触发 onToggleCollapse", () => {
    const onToggleCollapse = vi.fn();
    render(<Sidebar {...base} onToggleCollapse={onToggleCollapse} />);
    fireEvent.click(screen.getByRole("button", { name: "收起侧边栏" }));
    expect(onToggleCollapse).toHaveBeenCalled();
  });

  it("任务与项目折叠按钮暴露 aria-expanded 状态", () => {
    render(<Sidebar {...base} />);
    const tasks = screen.getByRole("button", { name: /^\u4efb\u52a1/ });
    const projects = screen.getByRole("button", { name: /^\u9879\u76ee \(/ });

    expect(tasks).toHaveAttribute("aria-expanded", "true");
    expect(projects).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(tasks);
    fireEvent.click(projects);
    expect(tasks).toHaveAttribute("aria-expanded", "false");
    expect(projects).toHaveAttribute("aria-expanded", "false");
  });

  it("升级后旧默认目录会话仍显示为任务且不生成用户名空间", () => {
    useSessionsStore.setState({
      independent: [{ sessionId: "legacy", title: "升级前任务", cwd: "/Users/fuyuxiang" }],
      workspaces: [{ cwd: "/Users/fuyuxiang", sessionCount: 1 }],
      homeCwd: "/Users/fuyuxiang/Documents/EchoAgent",
    });

    render(<Sidebar {...base} />);

    expect(screen.getByText("升级前任务")).toBeInTheDocument();
    expect(screen.queryByText("fuyuxiang")).toBeNull();
    expect(screen.getByRole("button", { name: "项目 (0)" })).toBeInTheDocument();
  });

  it("项目会话只在其真实项目下展示", () => {
    useSessionsStore.setState({
      independent: [{ sessionId: "project-session", title: "项目对话", cwd: "/workspace" }],
    });
    useProjectsStore.setState({
      projects: [{
        id: "project-1",
        name: "客户项目",
        cwd: "/workspace",
        createdAt: "2026-09-05T00:00:00.000Z",
        connectors: [], experts: [], skills: [], plans: [], tasks: [], assets: [], members: [],
        conversations: [{
          sessionId: "project-session",
          title: "项目对话",
          createdAt: "2026-09-05T00:00:00.000Z",
        }],
      }],
    });

    render(<Sidebar {...base} />);

    expect(screen.queryByText("项目对话")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开客户项目对话" }));
    expect(screen.getByText("项目对话")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^\u4efb\u52a1/ })).toHaveTextContent("任务 (0)");
  });

  it("hover「更多」只展示保留的功能入口", () => {
    const onNavigate = vi.fn();
    render(<Sidebar {...base} onNavigate={onNavigate} />);
    fireEvent.mouseEnter(screen.getByText("更多").closest(".sidebar__more-wrap")!);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByText("我的文件")).toBeInTheDocument();
    expect(screen.getByText("知识库")).toBeInTheDocument();
    expect(screen.getByText("个人记忆")).toBeInTheDocument();
    expect(screen.getByText("插件市场")).toBeInTheDocument();
    expect(screen.getByText("用量统计")).toBeInTheDocument();
    for (const removed of ["灵感", "网页预览", "策略设置", "发现"]) {
      expect(screen.queryByText(removed)).not.toBeInTheDocument();
    }
  });

  it("「更多」菜单的个人记忆与插件市场进入稳定路由", () => {
    const onNavigate = vi.fn();
    const { rerender } = render(<Sidebar {...base} onNavigate={onNavigate} />);
    fireEvent.mouseEnter(screen.getByText("更多").closest(".sidebar__more-wrap")!);
    fireEvent.click(screen.getByText("个人记忆"));
    expect(onNavigate).toHaveBeenCalledWith("个人记忆");

    rerender(<Sidebar {...base} onNavigate={onNavigate} />);
    fireEvent.mouseEnter(screen.getByText("更多").closest(".sidebar__more-wrap")!);
    fireEvent.click(screen.getByText("插件市场"));
    expect(onNavigate).toHaveBeenCalledWith("插件·市场");
  });

  it("「更多」菜单可进入知识库", async () => {
    const onNavigate = vi.fn();
    const user = userEvent.setup();
    render(<Sidebar {...base} onNavigate={onNavigate} onToast={vi.fn()} />);
    await user.hover(screen.getByText("更多"));
    const menu = await screen.findByRole("menu");
    expect(menu).toBeInTheDocument();
    fireEvent.click(screen.getByText("知识库"));
    expect(onNavigate).toHaveBeenCalledWith("知识库");
  });

  it("「更多」菜单支持方向键、Home/End 和 Escape 焦点回退", async () => {
    const user = userEvent.setup();
    render(<Sidebar {...base} />);
    const trigger = screen.getByRole("button", { name: /更多/ });
    trigger.focus();

    await user.keyboard("{ArrowDown}");
    const menu = screen.getByRole("menu", { name: "更多功能" });
    const items = within(menu).getAllByRole("menuitem");
    expect(items[0]).toHaveFocus();

    await user.keyboard("{ArrowDown}");
    expect(items[1]).toHaveFocus();
    await user.keyboard("{End}");
    expect(items[items.length - 1]).toHaveFocus();
    await user.keyboard("{Home}");
    expect(items[0]).toHaveFocus();
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("menu", { name: "更多功能" })).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("任务筛选菜单可用方向键打开、循环导航并用 Escape 关闭", async () => {
    const user = userEvent.setup();
    render(<Sidebar {...base} />);
    const trigger = screen.getByRole("button", { name: "筛选任务" });
    trigger.focus();

    await user.keyboard("{ArrowUp}");
    const menu = screen.getByRole("menu", { name: "任务筛选" });
    const items = within(menu).getAllByRole("menuitemradio");
    expect(items[items.length - 1]).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(items[0]).toHaveFocus();
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("menu", { name: "任务筛选" })).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("归档筛选可查看并恢复会话", async () => {
    useSessionsStore.getState().setIndependent([
      { sessionId: "active", title: "活动会话", cwd: "/home", archived: false },
      { sessionId: "archived", title: "归档会话", cwd: "/home", archived: true },
    ]);
    const onSessionArchived = vi.fn();
    render(<Sidebar {...base} onSessionArchived={onSessionArchived} />);
    expect(screen.getByText("活动会话")).toBeInTheDocument();
    expect(screen.queryByText("归档会话")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "筛选任务" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "已归档会话" }));
    expect(screen.getByText("归档会话")).toBeInTheDocument();
    expect(screen.queryByTitle("活动会话")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "归档会话的会话操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /\u6062\u590d\u4f1a\u8bdd/ }));
    await waitFor(() => expect(onSessionArchived).toHaveBeenCalledWith("archived", false));
    expect(useSessionsStore.getState().independent.find((item) => item.sessionId === "archived")?.archived).toBe(false);
  });
});
