import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ProjectsPanel } from "../ProjectsPanel";
import { useProjectsStore, type ProjectMeta } from "@/stores/projects-store";
import { projectAssetsRemoveAll } from "@/lib/agent-client";

vi.mock("../project-picker", async () => {
  const actual = await vi.importActual<typeof import("../project-picker")>("../project-picker");
  return {
    ...actual,
    useProjectPickerOptions: () => ({
      options: { connectors: [], experts: [], skills: [] },
      loading: false,
      error: null,
    }),
  };
});

vi.mock("@/lib/agent-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/agent-client")>("@/lib/agent-client");
  return {
    ...actual,
    projectsSave: vi.fn().mockResolvedValue(undefined),
    projectAssetsRemoveAll: vi.fn().mockResolvedValue(undefined),
  };
});

const project: ProjectMeta = {
  id: "project-1",
  name: "测试项目",
  createdAt: new Date().toISOString(),
  connectors: [],
  experts: [],
  skills: [],
  plans: [],
  tasks: [],
  assets: [],
  members: [],
  conversations: [],
};

function setViewport(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
}

function rect(top: number, bottom: number): DOMRect {
  return {
    x: 820,
    y: top,
    top,
    bottom,
    left: 820,
    right: 860,
    width: 40,
    height: bottom - top,
    toJSON: () => ({}),
  };
}

describe("ProjectsPanel 项目操作菜单", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setViewport(1000, 600);
    useProjectsStore.setState({
      projects: [structuredClone(project)],
      activeProjectId: null,
      persisting: false,
      persistError: null,
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("通过 body portal 渲染，不受项目卡片堆叠上下文限制", () => {
    render(<ProjectsPanel />);
    const trigger = screen.getByRole("button", { name: "更多操作" });
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue(rect(200, 228));

    fireEvent.click(trigger);

    const menu = screen.getByRole("menu", { name: "测试项目 操作菜单" });
    expect(menu.parentElement).toBe(document.body);
    expect(menu.closest(".project-card2")).toBeNull();
    expect(menu).toHaveStyle({ position: "fixed", zIndex: "1200" });
    expect(menu).toHaveAttribute("data-placement", "bottom");
    expect(screen.getByRole("menuitem", { name: "删除" })).toBeVisible();
  });

  it("底部空间不足时向上展开，避免与“从模版创建”卡片重叠", () => {
    render(<ProjectsPanel />);
    const trigger = screen.getByRole("button", { name: "更多操作" });
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue(rect(540, 568));

    fireEvent.click(trigger);

    const menu = screen.getByRole("menu");
    expect(menu).toHaveAttribute("data-placement", "top");
    expect(Number.parseFloat(menu.style.top)).toBeLessThan(540);
  });

  it("页面滚动后跟随触发按钮重新定位", () => {
    render(<ProjectsPanel />);
    const trigger = screen.getByRole("button", { name: "更多操作" });
    let triggerRect = rect(200, 228);
    vi.spyOn(trigger, "getBoundingClientRect").mockImplementation(() => triggerRect);

    fireEvent.click(trigger);
    expect(screen.getByRole("menu")).toHaveAttribute("data-placement", "bottom");

    triggerRect = rect(540, 568);
    fireEvent.scroll(window);
    expect(screen.getByRole("menu")).toHaveAttribute("data-placement", "top");
  });

  it("Portal 中的删除项可点击并执行原有删除流程", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<ProjectsPanel />);
    const trigger = screen.getByRole("button", { name: "更多操作" });
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue(rect(200, 228));

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));

    await waitFor(() => expect(projectAssetsRemoveAll).toHaveBeenCalledWith("project-1"));
    await waitFor(() => expect(useProjectsStore.getState().projects).toEqual([]));
  });

  it("点击外部或按 Escape 都会关闭菜单", () => {
    render(<ProjectsPanel />);
    const trigger = screen.getByRole("button", { name: "更多操作" });
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue(rect(200, 228));

    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(trigger);
    fireEvent.mouseDown(screen.getByRole("heading", { name: "项目" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
