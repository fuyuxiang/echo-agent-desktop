import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Sidebar } from "../Sidebar";
import { useSessionsStore } from "@/stores/sessions-store";

const base = {
  onNewSession: vi.fn(),
  onSelect: vi.fn(),
  onNavigate: vi.fn(),
  onOpenSettings: vi.fn(),
  onToggleCollapse: vi.fn(),
  onToggleWorkspace: vi.fn(),
  onOpenSearch: vi.fn(),
  onPlaceholder: vi.fn(),
  activeNav: "新建任务",
};

describe("Sidebar", () => {
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
    useSessionsStore.getState().setIndependent([]);
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

  it("左下角本地用户与操作按钮保持同一行", () => {
    render(<Sidebar {...base} />);
    const user = screen.getByRole("button", { name: "本地用户" });
    const footer = user.closest(".sidebar__footer");

    expect(user.querySelector(".sidebar__user-label")).toHaveTextContent("本地用户");
    expect(footer?.querySelector(".sidebar__logo-spacer")).toBeNull();
    expect(footer?.children).toHaveLength(3);
  });

  it("收起侧边栏按钮触发 onToggleCollapse", () => {
    const onToggleCollapse = vi.fn();
    render(<Sidebar {...base} onToggleCollapse={onToggleCollapse} />);
    fireEvent.click(screen.getByRole("button", { name: "收起侧边栏" }));
    expect(onToggleCollapse).toHaveBeenCalled();
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
});
