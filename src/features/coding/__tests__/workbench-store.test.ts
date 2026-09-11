import { beforeEach, describe, expect, it } from "vitest";

import { useWorkbenchStore, WORKBENCH_LAYOUT_KEY } from "../store/workbench-store";

describe("workbench layout store", () => {
  beforeEach(() => {
    localStorage.clear();
    useWorkbenchStore.getState().resetLayout();
  });

  it("clamps pane widths so a pane can never be dragged away", () => {
    useWorkbenchStore.getState().setExplorerWidth(20);
    expect(useWorkbenchStore.getState().explorerWidth).toBe(180);
    useWorkbenchStore.getState().setExplorerWidth(5_000);
    expect(useWorkbenchStore.getState().explorerWidth).toBe(520);

    useWorkbenchStore.getState().setAgentWidth(10);
    expect(useWorkbenchStore.getState().agentWidth).toBe(300);
    useWorkbenchStore.getState().setAgentWidth(9_999);
    expect(useWorkbenchStore.getState().agentWidth).toBe(720);
  });

  it("persists layout across store recreation", () => {
    useWorkbenchStore.getState().setExplorerWidth(300);
    useWorkbenchStore.getState().setAgentWidth(400);
    useWorkbenchStore.getState().setBottomHeight(260);
    const stored = JSON.parse(localStorage.getItem(WORKBENCH_LAYOUT_KEY) ?? "{}");
    expect(stored.explorerWidth).toBe(300);
    expect(stored.agentWidth).toBe(400);
    expect(stored.bottomHeight).toBe(260);
  });

  it("ignores corrupt stored layout instead of crashing", () => {
    localStorage.setItem(WORKBENCH_LAYOUT_KEY, "{not json");
    expect(() => useWorkbenchStore.getState().hydrateLayout()).not.toThrow();
    expect(useWorkbenchStore.getState().explorerWidth).toBe(238);
  });

  it("restores a persisted layout on hydrate", () => {
    localStorage.setItem(
      WORKBENCH_LAYOUT_KEY,
      JSON.stringify({ explorerWidth: 320, agentWidth: 500, bottomHeight: 300 }),
    );
    useWorkbenchStore.getState().hydrateLayout();
    expect(useWorkbenchStore.getState().explorerWidth).toBe(320);
    expect(useWorkbenchStore.getState().agentWidth).toBe(500);
    expect(useWorkbenchStore.getState().bottomHeight).toBe(300);
  });

  it("toggling the bottom panel keeps its restored height", () => {
    useWorkbenchStore.getState().setBottomHeight(300);
    useWorkbenchStore.getState().toggleBottom();
    expect(useWorkbenchStore.getState().bottomOpen).toBe(true);
    useWorkbenchStore.getState().toggleBottom();
    expect(useWorkbenchStore.getState().bottomOpen).toBe(false);
    expect(useWorkbenchStore.getState().bottomHeight).toBe(300);
  });

  it("selecting a bottom view opens the panel", () => {
    expect(useWorkbenchStore.getState().bottomOpen).toBe(false);
    useWorkbenchStore.getState().setBottomView("tests");
    expect(useWorkbenchStore.getState().bottomView).toBe("tests");
    expect(useWorkbenchStore.getState().bottomOpen).toBe(true);
  });
});
