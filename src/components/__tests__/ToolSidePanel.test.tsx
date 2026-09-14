import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToolSidePanel } from "../ToolSidePanel";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

function renderPanel() {
  return render(
    <ToolSidePanel
      open
      mode="artifacts"
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
});
