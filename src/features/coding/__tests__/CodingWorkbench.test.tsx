import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async (command: string, _args?: unknown) => {
  if (command === "coding_task_list") return [];
  if (command === "coding_verification_detect") return [];
  return null;
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args: unknown) => invoke(command, args),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@/components/workspace-panel/FileTreeView", () => ({
  FileTreeView: () => <div data-testid="file-tree" />,
}));
vi.mock("@/lib/agent-client", () => ({
  filesystemPickDirectory: vi.fn(async () => "/picked"),
  listDir: vi.fn(async () => []),
}));

import { CodingWorkbench } from "../CodingWorkbench";

describe("CodingWorkbench skeleton", () => {
  beforeEach(() => {
    localStorage.clear();
    invoke.mockClear();
  });

  it("prompts to open a folder when no workspace is selected", () => {
    render(<CodingWorkbench cwd="" models={[]} />);
    expect(screen.getByRole("button", { name: /选择代码文件夹/ })).toBeInTheDocument();
  });

  it("renders the four panes and the status bar for a workspace", async () => {
    render(<CodingWorkbench cwd="/repo" models={[{ id: "m1" }]} defaultModelId="m1" />);
    expect(await screen.findByRole("navigation", { name: "活动栏" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "资源管理器" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Agent 面板" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "工作台状态" })).toBeInTheDocument();
  });

  it("exposes draggable separators for both side panes", async () => {
    render(<CodingWorkbench cwd="/repo" models={[]} />);
    const separators = await screen.findAllByRole("separator");
    const labels = separators.map((node) => node.getAttribute("aria-label"));
    expect(labels).toContain("调整资源管理器宽度");
    expect(labels).toContain("调整 Agent 面板宽度");
  });

  it("keeps the bottom panel collapsed until it is opened", async () => {
    render(<CodingWorkbench cwd="/repo" models={[]} />);
    await screen.findByRole("navigation", { name: "活动栏" });
    expect(screen.queryByRole("tablist", { name: "开发工具面板" })).not.toBeInTheDocument();
  });

  it("opens the command palette from the top bar", async () => {
    const user = userEvent.setup();
    render(<CodingWorkbench cwd="/repo" models={[]} />);
    await user.click(await screen.findByRole("button", { name: "打开命令面板" }));
    expect(screen.getByRole("dialog", { name: "命令面板" })).toBeInTheDocument();
  });

  it("binds command, quick-open and symbol shortcuts", async () => {
    const user = userEvent.setup();
    render(<CodingWorkbench cwd="/repo" models={[]} />);
    await screen.findByRole("navigation", { name: "活动栏" });

    // ⌘⇧P opens command mode; ⌘K is left to the application's session search.
    await user.keyboard("{Meta>}{Shift>}p{/Shift}{/Meta}");
    expect(screen.getByRole("tab", { name: "命令", selected: true })).toBeInTheDocument();
    await user.keyboard("{Escape}");

    await user.keyboard("{Meta>}p{/Meta}");
    expect(screen.getByRole("tab", { name: "文件", selected: true })).toBeInTheDocument();
    await user.keyboard("{Escape}");

    await user.keyboard("{Meta>}t{/Meta}");
    expect(screen.getByRole("tab", { name: "符号", selected: true })).toBeInTheDocument();
  });

  it("does not bind shortcuts before a workspace is open", async () => {
    const user = userEvent.setup();
    render(<CodingWorkbench cwd="" models={[]} />);
    await user.keyboard("{Meta>}{Shift>}p{/Shift}{/Meta}");
    expect(screen.queryByRole("dialog", { name: "命令面板" })).not.toBeInTheDocument();
  });

  it("applies persisted pane widths as CSS variables", async () => {
    localStorage.setItem(
      "echo-coding-workbench-layout",
      JSON.stringify({ explorerWidth: 300, agentWidth: 460, bottomHeight: 240 }),
    );
    const { container } = render(<CodingWorkbench cwd="/repo" models={[]} />);
    await screen.findByRole("navigation", { name: "活动栏" });
    const shell = container.querySelector(".coding-workbench") as HTMLElement;
    expect(shell.style.getPropertyValue("--coding-explorer-width")).toBe("300px");
    expect(shell.style.getPropertyValue("--coding-agent-width")).toBe("460px");
  });
});
