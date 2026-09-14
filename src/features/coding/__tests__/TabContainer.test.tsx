import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("../main/CodingEditor", () => ({
  CodingEditor: ({ value, mode }: { value: string; mode: string }) => (
    <div data-testid="editor" data-mode={mode}>
      {value}
    </div>
  ),
}));

import { TabContainer } from "../main/TabContainer";
import type { FileTab, WorkbenchTab } from "../store/tab-store";

function file(overrides: Partial<FileTab> = {}): FileTab {
  return {
    type: "file",
    id: "/repo/src/auth/login.ts",
    relativePath: "src/auth/login.ts",
    name: "login.ts",
    language: "typescript",
    original: "disk",
    draft: "disk",
    hash: "h1",
    view: "edit",
    loading: false,
    ...overrides,
  };
}

function setup(tabs: WorkbenchTab[], activeId: string | null = tabs[0]?.id ?? null) {
  const props = {
    tabs,
    activeId,
    onSelect: vi.fn(),
    onClose: vi.fn(),
    onDraftChange: vi.fn(),
    onSave: vi.fn(),
    onViewChange: vi.fn(),
    onGenerateDocumentation: vi.fn(),
    renderDoc: vi.fn((kind: string) => <div data-testid="doc">{kind}</div>),
  };
  render(<TabContainer {...props} />);
  return props;
}

describe("TabContainer", () => {
  it("guides the user when nothing is open", () => {
    setup([]);
    expect(screen.getByText(/⌘P 快速查找/)).toBeInTheDocument();
  });

  it("shows a breadcrumb of the file path", () => {
    setup([file()]);
    const crumb = screen.getByLabelText("文件路径");
    expect(crumb).toHaveTextContent("src");
    expect(crumb).toHaveTextContent("auth");
    expect(crumb).toHaveTextContent("login.ts");
  });

  it("marks a dirty tab", () => {
    setup([file({ draft: "edited" })]);
    expect(screen.getByLabelText("未保存")).toBeInTheDocument();
  });

  it("does not mark a saved tab", () => {
    setup([file()]);
    expect(screen.queryByLabelText("未保存")).not.toBeInTheDocument();
  });

  it("selects and closes tabs", async () => {
    const user = userEvent.setup();
    const props = setup([file(), file({ id: "b", name: "b.ts", relativePath: "b.ts" })]);
    await user.click(screen.getByRole("tab", { name: /b\.ts/ }));
    expect(props.onSelect).toHaveBeenCalledWith("b");
    await user.click(screen.getByRole("button", { name: "关闭 b.ts" }));
    expect(props.onClose).toHaveBeenCalledWith("b");
  });

  it("switches between edit and diff views", async () => {
    const user = userEvent.setup();
    const props = setup([file()]);
    await user.click(screen.getByRole("button", { name: "差异" }));
    expect(props.onViewChange).toHaveBeenCalledWith("/repo/src/auth/login.ts", "diff");
  });

  it("starts documentation from the editor toolbar and protects unsaved drafts", async () => {
    const user = userEvent.setup();
    const props = setup([file()]);
    await user.click(screen.getByRole("button", { name: "为当前选区或符号生成注释" }));
    expect(props.onGenerateDocumentation).toHaveBeenCalledOnce();

    setup([file({ id: "dirty", relativePath: "dirty.ts", draft: "unsaved" })], "dirty");
    const dirtyButton = screen.getAllByRole("button", { name: "为当前选区或符号生成注释" })[1];
    expect(dirtyButton).toBeDisabled();
    expect(dirtyButton).toHaveAttribute("title", "请先保存当前文件，再让 Agent 生成注释");
  });

  it("explains why documentation is unavailable in diff view", () => {
    setup([file({ view: "diff" })]);
    const button = screen.getByRole("button", { name: "为当前选区或符号生成注释" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "请先切换到编辑视图，再让 Agent 生成注释");
  });

  it("shows an accessible loading state while the latest diff is being fetched", () => {
    const props = {
      tabs: [file()],
      activeId: "/repo/src/auth/login.ts",
      onSelect: vi.fn(),
      onClose: vi.fn(),
      onDraftChange: vi.fn(),
      onSave: vi.fn(),
      onViewChange: vi.fn(),
      viewBusy: true,
      renderDoc: vi.fn(),
    };
    render(<TabContainer {...props} />);
    const button = screen.getByRole("button", { name: "正在加载最新差异" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveTextContent("刷新中…");
  });

  it("passes the requested view to the editor", () => {
    setup([file({ view: "diff" })]);
    expect(screen.getByTestId("editor")).toHaveAttribute("data-mode", "diff");
  });

  it("warns before overwriting a file changed by someone else", () => {
    setup([file({ conflict: true })]);
    expect(screen.getByRole("alert")).toHaveTextContent(/已被 Agent 或其他程序修改/);
  });

  it("shows a load error instead of an empty editor", () => {
    setup([file({ error: "读取文件失败" })]);
    expect(screen.getByText("读取文件失败")).toBeInTheDocument();
    expect(screen.queryByTestId("editor")).not.toBeInTheDocument();
  });

  it("renders a virtual document tab through the provided renderer", () => {
    const props = setup([{ type: "doc", id: "doc:delivery", kind: "delivery", title: "交付报告" }]);
    expect(screen.getByTestId("doc")).toHaveTextContent("delivery");
    expect(props.renderDoc).toHaveBeenCalledWith("delivery");
  });

  it("keeps file and document tabs side by side in one strip", () => {
    setup([file(), { type: "doc", id: "doc:profile", kind: "profile", title: "工程画像" }]);
    const strip = screen.getByRole("tablist", { name: "打开的标签页" });
    expect(strip).toHaveTextContent("login.ts");
    expect(strip).toHaveTextContent("工程画像");
  });
});
