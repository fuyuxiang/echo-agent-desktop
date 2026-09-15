import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToolSidePanel, type ToolSidePanelMode } from "../ToolSidePanel";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

function renderPanel(mode: ToolSidePanelMode = "artifacts") {
  return render(
    <ToolSidePanel
      open
      mode={mode}
      artifacts={[]}
      messages={[]}
      sessionId="session-1"
      onClose={vi.fn()}
      onSelectTool={vi.fn()}
      onSelectArtifact={vi.fn()}
      onOpenArtifacts={vi.fn()}
    />,
  );
}

describe("ToolSidePanel navigation collapse", () => {
  beforeEach(() => localStorage.clear());

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

  it("keeps the navigation expanded when pinning and unpinning", () => {
    const { container } = renderPanel("fileTree");

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
      expect(nav?.style.width).toBe("140px");
      expect(container.querySelector(".tool-side-panel__nav-body")).toBeInTheDocument();

      await waitFor(() => {
        expect(localStorage.getItem("tool-side-panel-width")).toBe("280");
        expect(localStorage.getItem("tool-side-panel-nav-width")).toBe("140");
      });
    },
  );
});
