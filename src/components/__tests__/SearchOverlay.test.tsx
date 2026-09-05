import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SearchOverlay } from "../SearchOverlay";
import { useSessionsStore } from "@/stores/sessions-store";

vi.mock("@/lib/agent-client", () => ({
  sessionSearch: vi.fn(),
  agentListSessions: vi.fn(),
}));

const { sessionSearch, agentListSessions } = await import("@/lib/agent-client");

describe("SearchOverlay", () => {
  beforeEach(() => {
    vi.mocked(sessionSearch).mockReset().mockResolvedValue([]);
    vi.mocked(agentListSessions).mockReset().mockResolvedValue([]);
    useSessionsStore.setState({
      independent: [],
      workspaces: [],
      homeCwd: "/home",
      currentSessionId: null,
      filterStatus: null,
      filterDate: null,
      filterArchived: false,
      pendingSessionPatches: {},
    });
  });

  it("FTS 命中先 hydrate 完整摘要再打开", async () => {
    vi.mocked(sessionSearch).mockResolvedValue([{
      sessionId: "remote",
      title: "远程命中",
      cwd: "/workspace",
      snippet: "命中内容",
    }]);
    vi.mocked(agentListSessions).mockResolvedValue([{
      sessionId: "remote",
      title: "完整标题",
      cwd: "/workspace",
      currentModelId: "model-a",
    }]);
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<SearchOverlay open onClose={onClose} onSelect={onSelect} />);

    fireEvent.change(screen.getByRole("textbox", { name: "搜索会话标题或内容" }), {
      target: { value: "远程" },
    });
    fireEvent.click(await screen.findByRole("button", { name: /\u8fdc\u7a0b\u547d\u4e2d/ }));

    await waitFor(() => expect(agentListSessions).toHaveBeenCalledWith("/workspace", true));
    expect(onSelect).toHaveBeenCalledWith("remote", "/workspace");
    expect(useSessionsStore.getState().independent[0]).toMatchObject({
      title: "完整标题",
      currentModelId: "model-a",
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("FTS 失败显示错误与重试，不伪装成空结果", async () => {
    vi.mocked(sessionSearch).mockRejectedValue(new Error("index unavailable"));
    render(<SearchOverlay open onClose={vi.fn()} onSelect={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox", { name: "搜索会话标题或内容" }), {
      target: { value: "检索" },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("index unavailable");
    expect(screen.getByRole("button", { name: "重试搜索" })).toBeInTheDocument();
    expect(screen.queryByText("没有匹配的会话")).toBeNull();
  });

  it("本地与 FTS 重复时保留带 snippet 的 FTS 结果", async () => {
    useSessionsStore.getState().setIndependent([{
      sessionId: "same",
      title: "相同会话",
      cwd: "/home",
    }]);
    vi.mocked(sessionSearch).mockResolvedValue([{
      sessionId: "same",
      title: "相同会话",
      cwd: "/home",
      snippet: "独特正文片段",
    }]);
    render(<SearchOverlay open onClose={vi.fn()} onSelect={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox", { name: "搜索会话标题或内容" }), {
      target: { value: "相同" },
    });
    expect(await screen.findByText("独特正文片段")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /\u76f8\u540c\u4f1a\u8bdd/ })).toHaveLength(1);
  });
});
