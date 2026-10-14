import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { McpServerStatusEvent } from "@/lib/agent-client";

const mocks = vi.hoisted(() => ({
  mcpList: vi.fn(),
  onMcpStatusEvent: vi.fn(),
}));

vi.mock("@/stores/session-store", () => {
  const state = { sessionId: "session-1" };
  const useSessionStore = Object.assign(
    (selector: (value: typeof state) => unknown) => selector(state),
    { getState: () => state },
  );
  return { useSessionStore };
});
vi.mock("@/lib/ensure-session", () => ({ ensureSession: vi.fn(async () => "session-1") }));
vi.mock("@/lib/agent-client", () => ({
  mcpList: mocks.mcpList,
  mcpToggle: vi.fn(),
  mcpDelete: vi.fn(),
  mcpSetup: vi.fn(),
  mcpToggleTool: vi.fn(),
  onMcpStatusEvent: mocks.onMcpStatusEvent,
}));

import { McpModal } from "../experts-panel/connectors/McpModal";
import type { McpServerEntry } from "@/lib/types";

function makeEntry(overrides: Partial<McpServerEntry> & { name: string }): McpServerEntry {
  return {
    displayName: overrides.displayName ?? overrides.name,
    transport: overrides.transport ?? "stdio",
    target: overrides.target,
    enabled: overrides.enabled ?? true,
    source: overrides.source ?? "user",
    status: overrides.status ?? "ready",
    live: overrides.live ?? false,
    authRequired: overrides.authRequired ?? false,
    setupRequired: overrides.setupRequired ?? false,
    setup: overrides.setup,
    setupValues: overrides.setupValues ?? {},
    tools: overrides.tools ?? [],
    args: overrides.args ?? [],
    env: overrides.env ?? {},
    editable: overrides.editable ?? true,
    ...overrides,
  };
}

describe("MCP 服务管理列表渲染契约", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.onMcpStatusEvent.mockReset().mockResolvedValue(() => {});
  });

  it("渲染多个条目时,每个条目都包在 .mcp-item-wrap 内且包含开关与名称", async () => {
    mocks.mcpList.mockResolvedValue([
      makeEntry({ name: "ai-search", displayName: "AI Search" }),
      makeEntry({ name: "echogent", displayName: "EchoGent" }),
      makeEntry({ name: "git", displayName: "Git" }),
      makeEntry({ name: "playwright", displayName: "Playwright" }),
    ]);

    render(<McpModal onClose={vi.fn()} />);

    // 列表容器与每个 wrap 都在加载完成后才渲染
    await waitFor(() => {
      expect(document.querySelector(".mcp-list")).not.toBeNull();
      const wraps = document.querySelectorAll(".mcp-item-wrap");
      expect(wraps.length).toBe(4);
    });

    // 每条目都有 toggle 开关(checkbox)
    const wraps = document.querySelectorAll(".mcp-item-wrap");
    wraps.forEach((wrap) => {
      const checkboxes = wrap.querySelectorAll('input[type="checkbox"]');
      expect(checkboxes.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("搜索过滤后只渲染匹配条目,且容器仍是 .mcp-list", async () => {
    mocks.mcpList.mockResolvedValue([
      makeEntry({ name: "ai-search" }),
      makeEntry({ name: "echogent" }),
      makeEntry({ name: "git" }),
      makeEntry({ name: "playwright" }),
    ]);

    render(<McpModal onClose={vi.fn()} />);

    const search = await screen.findByRole("textbox", { name: /搜索 MCP 服务/ });
    // 输入 "git" 应只剩 1 个条目
    const user = await import("@testing-library/user-event");
    const ue = user.default.setup();
    await ue.type(search, "git");

    await waitFor(() => {
      expect(document.querySelectorAll(".mcp-item-wrap").length).toBe(1);
    });
    expect(document.querySelector(".mcp-list")).not.toBeNull();
  });

  it("0 条目时显示空状态占位,不渲染 .mcp-item-wrap", async () => {
    mocks.mcpList.mockResolvedValue([]);
    render(<McpModal onClose={vi.fn()} />);
    expect(await screen.findByText("暂无 MCP 服务")).toBeInTheDocument();
    expect(document.querySelectorAll(".mcp-item-wrap").length).toBe(0);
  });

  it("只显示活动会话的诊断事件", async () => {
    let handler!: (event: McpServerStatusEvent) => void;
    mocks.onMcpStatusEvent.mockImplementation(async (callback) => { handler = callback; return () => {}; });
    mocks.mcpList.mockResolvedValue([makeEntry({ name: "demo", displayName: "Current MCP" })]);
    render(<McpModal onClose={vi.fn()} />);
    fireEvent.click(await screen.findByText("Current MCP"));
    act(() => handler({ sessionId: "other-session", name: "demo", source: "local", status: "unavailable", reason: "handshake_failed", detail: "其他任务的诊断" }));
    expect(screen.queryByText("其他任务的诊断")).toBeNull();
    act(() => handler({ sessionId: "session-1", name: "demo", source: "local", status: "unavailable", reason: "handshake_failed", detail: "当前任务的诊断" }));
    expect(screen.getByText("当前任务的诊断")).toBeInTheDocument();
  });

  it("面板卸载后迟到的监听注册立即注销", async () => {
    let resolve!: (stop: () => void) => void;
    const stop = vi.fn();
    mocks.onMcpStatusEvent.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    mocks.mcpList.mockResolvedValue([]);
    const { unmount } = render(<McpModal onClose={vi.fn()} />);
    unmount();
    await act(async () => resolve(stop));
    expect(stop).toHaveBeenCalledOnce();
  });
});
