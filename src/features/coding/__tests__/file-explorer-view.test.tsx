import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { FileExplorerView } from "../explorer/FileExplorerView";
import type { WorkbenchTab } from "../store/tab-store";

const tabs: WorkbenchTab[] = [
  {
    type: "file",
    id: "/repo/src/index.ts",
    relativePath: "src/index.ts",
    name: "index.ts",
    language: "typescript",
    original: "const value = 1;",
    draft: "const value = 2;",
    hash: "hash",
    view: "edit",
    loading: false,
  },
  {
    type: "doc",
    id: "doc:delivery",
    kind: "delivery",
    title: "交付报告",
  },
];

function setup() {
  const props = {
    root: "/repo",
    tabs,
    activeId: "/repo/src/index.ts",
    symbols: [{ name: "run", detail: "function", path: "/repo/src/index.ts", line: 12 }],
    activeFileName: "src/index.ts",
    showHidden: false,
    fileTree: <div data-testid="file-tree">tree</div>,
    onSelectTab: vi.fn(),
    onCloseTab: vi.fn(),
    onOpenSymbol: vi.fn(),
    onNewFile: vi.fn(),
    onNewDirectory: vi.fn(),
    onRefresh: vi.fn(),
    onCollapseAll: vi.fn(),
    onRevealActive: vi.fn(),
    onToggleHidden: vi.fn(),
  };
  render(<FileExplorerView {...props} />);
  return props;
}

describe("FileExplorerView", () => {
  it("稳定呈现已打开编辑器、项目根目录和当前文件大纲", () => {
    setup();
    expect(screen.getByRole("button", { name: /已打开的编辑器/ })).toBeInTheDocument();
    expect(screen.getByTitle("src/index.ts")).toHaveTextContent("●");
    expect(screen.getByRole("button", { name: /REPO/ })).toBeInTheDocument();
    expect(screen.getByText("项目根目录")).toBeInTheDocument();
    expect(screen.getByTestId("file-tree")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /run/ })).toBeInTheDocument();
    expect(screen.getByText("交付报告")).toBeInTheDocument();
  });

  it("将工具栏、编辑器列表和大纲操作交给工作台", async () => {
    const user = userEvent.setup();
    const props = setup();

    await user.click(screen.getByRole("button", { name: "刷新资源管理器" }));
    await user.click(screen.getByRole("button", { name: "折叠所有目录" }));
    await user.click(screen.getByRole("button", { name: "在资源管理器中定位当前文件" }));
    await user.click(screen.getByRole("button", { name: "显示隐藏文件" }));
    await user.click(screen.getByTitle("src/index.ts"));
    await user.click(screen.getByRole("button", { name: "关闭 index.ts" }));
    await user.click(screen.getByRole("button", { name: /run/ }));

    expect(props.onRefresh).toHaveBeenCalledTimes(1);
    expect(props.onCollapseAll).toHaveBeenCalledTimes(1);
    expect(props.onRevealActive).toHaveBeenCalledTimes(1);
    expect(props.onToggleHidden).toHaveBeenCalledTimes(1);
    expect(props.onSelectTab).toHaveBeenCalledWith("/repo/src/index.ts");
    expect(props.onCloseTab).toHaveBeenCalledWith("/repo/src/index.ts");
    expect(props.onOpenSymbol).toHaveBeenCalledWith(expect.objectContaining({ name: "run" }));
  });
});
