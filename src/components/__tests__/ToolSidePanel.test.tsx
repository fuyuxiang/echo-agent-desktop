import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { ToolSidePanel, type ToolSidePanelMode } from "../ToolSidePanel";
import { SidebarLayoutContext, useAppSidebarLayout } from "@/lib/sidebar-layout";
import type { SessionArtifact } from "@/lib/session-artifacts";
import type { ToolCallView } from "@/stores/session-store";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

function renderPanel(
  mode: ToolSidePanelMode = "artifacts",
  artifacts: SessionArtifact[] = [],
  onToast = vi.fn(),
) {
  return render(
    <ToolSidePanel
      open
      mode={mode}
      artifacts={artifacts}
      cwd="C:\\work"
      messages={[]}
      sessionId="session-1"
      onClose={vi.fn()}
      onSelectTool={vi.fn()}
      onSelectArtifact={vi.fn()}
      onOpenArtifacts={vi.fn()}
      onToast={onToast}
    />,
  );
}

describe("ToolSidePanel navigation collapse", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(invoke).mockReset().mockResolvedValue([]);
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it("coordinates with the global sidebar without losing the user's preferred panel width", async () => {
    const originalViewport = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
    localStorage.setItem("app-sidebar-width", "400");
    localStorage.setItem("tool-side-panel-width", "380");
    function CoordinatedPanel() {
      const layout = useAppSidebarLayout();
      return <SidebarLayoutContext.Provider value={layout.context}>
        <div ref={layout.bodyRef}>
          <button onClick={() => layout.setCollapsed(true)}>隐藏全局导航</button>
          <button onClick={() => layout.setCollapsed(false)}>恢复全局导航</button>
          <ToolSidePanel open mode="artifacts" artifacts={[]} onClose={vi.fn()}
            onSelectTool={vi.fn()} onSelectArtifact={vi.fn()} onOpenArtifacts={vi.fn()} />
        </div>
      </SidebarLayoutContext.Provider>;
    }
    try {
      const { container } = render(<CoordinatedPanel />);
      const panel = container.querySelector<HTMLElement>(".tool-side-panel")!;
      expect(panel.style.width).toBe("280px");
      expect(localStorage.getItem("tool-side-panel-width")).toBe("380");
      fireEvent.click(screen.getByText("隐藏全局导航"));
      await waitFor(() => expect(panel.style.width).toBe("380px"));
      fireEvent.click(screen.getByText("恢复全局导航"));
      await waitFor(() => expect(panel.style.width).toBe("280px"));
      expect(localStorage.getItem("tool-side-panel-width")).toBe("380");
    } finally {
      Object.defineProperty(window, "innerWidth", { value: originalViewport });
    }
  });

  it("replaces the full header with one accessible expand control", () => {
    const { container } = renderPanel();

    expect(screen.getByRole("button", { name: "收起导航" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "钉住左列" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "收起导航" }));

    expect(container.querySelector(".tool-side-panel__nav--collapsed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "展开导航" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "钉住左列" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "产物" })).not.toBeInTheDocument();
    expect(container.querySelector(".tool-side-panel__nav-body")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "展开导航" }));

    expect(container.querySelector(".tool-side-panel__nav--collapsed")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "收起导航" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "钉住左列" })).toBeInTheDocument();
  });

  it("keeps the navigation expanded when pinning and unpinning", async () => {
    const { container } = renderPanel("fileTree");
    await screen.findByText(/没有可见文件/);

    fireEvent.click(screen.getByRole("button", { name: "钉住左列" }));
    expect(screen.getByRole("button", { name: "取消钉住" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "收起导航" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "取消钉住" }));
    expect(screen.getByRole("button", { name: "钉住左列" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "收起导航" })).toBeInTheDocument();
    expect(container.querySelector(".tool-side-panel__nav--collapsed")).not.toBeInTheDocument();
    expect(container.querySelector(".tool-side-panel__nav-body")).toBeInTheDocument();
  });

  it.each(["fileTree", "browser"] as const)(
    "repairs invalid persisted widths before rendering the %s view",
    async (mode) => {
      localStorage.setItem("tool-side-panel-width", "1");
      localStorage.setItem("tool-side-panel-nav-width", "36");

      const { container } = renderPanel(mode);
      const panel = container.querySelector<HTMLElement>(".tool-side-panel");
      const nav = container.querySelector<HTMLElement>(".tool-side-panel__nav");

      expect(panel?.style.width).toBe("280px");
      if (mode === "fileTree") {
        expect(nav?.style.width).toBe("140px");
        expect(container.querySelector(".tool-side-panel__nav-body")).toBeInTheDocument();
      } else {
        expect(nav).toBeNull();
        expect(screen.getByRole("textbox", { name: "预览网址" })).toBeInTheDocument();
      }

      await waitFor(() => {
        expect(localStorage.getItem("tool-side-panel-width")).toBe("280");
        expect(localStorage.getItem("tool-side-panel-nav-width")).toBe("140");
      });
    },
  );

  it("keeps browser navigation usable without a blank list column and can switch back to files", async () => {
    const { container } = renderPanel("browser");
    fireEvent.change(screen.getByRole("textbox", { name: "预览网址" }), { target: { value: "https://example.com/review" } });
    fireEvent.click(screen.getByRole("button", { name: "预览" }));
    expect(container.querySelector("iframe")).toHaveAttribute("src", "https://example.com/review");
    fireEvent.click(screen.getByRole("button", { name: "浏览器" }));
    fireEvent.click(screen.getByRole("option", { name: "文件树" }));
    expect(await screen.findByText(/没有可见文件/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "收起导航" })).toBeInTheDocument();
  });

  it("waits for the persisted export receipt before reading a historical file", async () => {
    let authorize!: () => void;
    vi.mocked(invoke).mockImplementation(async command => {
      if (command === "session_export_authorize") return new Promise<void>(resolve => {authorize = resolve;});
      if (command === "read_text_file") return "restored export content";
      return undefined;
    });
    const exported = {...artifact("C:\\outside\\report.md"), kind: "document_export", toolCallId: `document-export:${"a".repeat(64)}`};
    renderPanel("artifacts", [exported]);
    fireEvent.click(screen.getByRole("button", {name: /^report\.md/}));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("session_export_authorize", {sessionId: "session-1", path: exported.path, sha256: "a".repeat(64)}));
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "read_text_file")).toBe(false);
    await act(async () => {authorize();});
    expect(await screen.findByText("restored export content")).toBeInTheDocument();
  });

  it("does not read an old export when its receipt ACK arrives after the session switches", async () => {
    let authorize!: () => void;
    vi.mocked(invoke).mockImplementation(async command => {
      if (command === "session_export_authorize") return new Promise<void>(resolve => {authorize = resolve;});
      return undefined;
    });
    const exported = {...artifact("C:\\outside\\report.md"), kind: "document_export", toolCallId: `document-export:${"a".repeat(64)}`};
    const props = {open: true, mode: "artifacts" as const, cwd: "C:\\work", onClose: vi.fn(), onSelectTool: vi.fn(), onSelectArtifact: vi.fn(), onOpenArtifacts: vi.fn()};
    const {rerender} = render(<ToolSidePanel {...props} artifacts={[exported]} sessionId="first" />);
    fireEvent.click(screen.getByRole("button", {name: /^report\.md/}));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("session_export_authorize", expect.anything()));
    rerender(<ToolSidePanel {...props} artifacts={[]} sessionId="second" />);
    await act(async () => {authorize();});
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "read_text_file")).toBe(false);
  });

  it("keeps a changed export visible with a useful error and does not open or read it", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("导出文件已移动、删除或内容已变化，请重新导出"));
    renderPanel("artifacts", [{...artifact("C:\\outside\\report.md"), kind: "document_export", toolCallId: `document-export:${"a".repeat(64)}`}]);
    fireEvent.click(screen.getByRole("button", {name: /^report\.md/}));
    expect(await screen.findByRole("alert")).toHaveTextContent("请重新导出");
    expect(screen.queryByRole("button", {name: "用系统应用打开"})).not.toBeInTheDocument();
    expect(vi.mocked(invoke).mock.calls.every(([command]) => command === "session_export_authorize")).toBe(true);
  });

  it("explains external-file authorization instead of offering a broken open action", async () => {
    vi.mocked(invoke).mockRejectedValue("拒绝访问未授权的路径：C:\\outside\\report.md");
    renderPanel("artifacts", [artifact("C:\\outside\\report.md")]);

    fireEvent.click(screen.getByRole("button", { name: /^report\.md/ }));

    expect(await screen.findByText(/位于当前工作区之外/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "选择该文件并授权预览" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "用系统应用打开" })).not.toBeInTheDocument();
  });

  it("retries the preview after the user authorizes the exact external file", async () => {
    let textReads = 0;
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "read_text_file") {
        textReads += 1;
        if (textReads === 1) throw new Error("拒绝访问未授权的路径：C:\\outside\\report.md");
        return "preview ready";
      }
      if (command === "filesystem_pick_files") return ["C:\\outside\\report.md"];
      if (command === "path_stat") {
        return { path: "C:\\outside\\report.md", exists: true, kind: "file", absolute: "C:\\outside\\report.md" };
      }
      return undefined;
    });
    const onToast = vi.fn();
    renderPanel("artifacts", [artifact("C:\\outside\\report.md")], onToast);
    fireEvent.click(screen.getByRole("button", { name: /^report\.md/ }));
    fireEvent.click(await screen.findByRole("button", { name: "选择该文件并授权预览" }));

    expect(await screen.findByText("preview ready")).toBeInTheDocument();
    expect(textReads).toBe(2);
    expect(onToast).toHaveBeenCalledWith("已授权该文件，可以在面板中预览");
    expect(screen.getByRole("button", { name: "用系统应用打开" })).toBeInTheDocument();
  });

  it("关联工具入口只打开工具，不再次触发文件选择覆盖工具模式", async () => {
    vi.mocked(invoke).mockResolvedValue("preview ready");
    const tc: ToolCallView = { toolCallId: "write-1", kind: "write", title: "Write report.md", status: "completed", content: [] };
    const onSelectTool = vi.fn();
    const onSelectArtifact = vi.fn();
    render(<ToolSidePanel open mode="artifacts" artifacts={[artifact("C:\\work\\report.md")]} cwd="C:\\work" sessionId="associated-tool-review"
      onClose={vi.fn()} onSelectTool={onSelectTool} onSelectArtifact={onSelectArtifact} onOpenArtifacts={vi.fn()} findToolCall={() => tc} />);
    fireEvent.click(screen.getByRole("button", { name: /^report\.md/ }));
    await screen.findByText("preview ready");
    onSelectArtifact.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "查看关联工具" }));
    expect(onSelectTool).toHaveBeenCalledTimes(1);
    expect(onSelectTool).toHaveBeenCalledWith(tc);
    expect(onSelectArtifact).not.toHaveBeenCalled();
  });

  it("缺失关联工具记录时提示并保留文件预览", async () => {
    vi.mocked(invoke).mockResolvedValue("preview ready");
    const onSelectTool = vi.fn();
    const onToast = vi.fn();
    render(<ToolSidePanel open mode="artifacts" artifacts={[artifact("C:\\work\\report.md")]} cwd="C:\\work" sessionId="missing-tool-review"
      onClose={vi.fn()} onSelectTool={onSelectTool} onSelectArtifact={vi.fn()} onOpenArtifacts={vi.fn()} onToast={onToast} findToolCall={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: /^report\.md/ }));
    await screen.findByText("preview ready");
    fireEvent.click(screen.getByRole("button", { name: "查看关联工具" }));
    expect(onSelectTool).not.toHaveBeenCalled();
    expect(onToast).toHaveBeenCalledWith("关联工具记录已不可用，可继续预览文件内容");
    expect(screen.getByText("preview ready")).toBeInTheDocument();
  });
});

function artifact(path: string): SessionArtifact {
  return {
    id: path.replace(/\\/g, "/").toLowerCase(),
    path,
    kind: "edit",
    title: `Write ${path}`,
    toolCallId: "write-1",
    status: "completed",
    verifiedOutput: true,
  };
}
