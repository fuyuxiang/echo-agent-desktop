// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

const api = vi.hoisted(() => ({
  memoryList: vi.fn(),
  memoryAppend: vi.fn(),
  memorySave: vi.fn(),
  memoryDelete: vi.fn(),
  memoryFlush: vi.fn(),
  memoryDream: vi.fn(),
  memoryRewrite: vi.fn(),
}));

vi.mock("@/lib/agent-client", () => api);

import { ResourcesPanel } from "../ResourcesPanel";

const GLOBAL_ENTRY = {
  scope: "global" as const,
  path: "MEMORY.md",
  content: "# Global\n\nOriginal",
  size: 19,
  revision: "rev-global",
  modifiedAt: "2026-08-31T00:00:00Z",
  readOnly: false,
};

const SESSION_ENTRY = {
  scope: "session" as const,
  path: "2026-08-31-session.md",
  content: "# Session log",
  size: 13,
  revision: "rev-session",
  modifiedAt: "2026-08-31T00:00:00Z",
  readOnly: true,
};

describe("ResourcesPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.memoryList.mockResolvedValue([GLOBAL_ENTRY, SESSION_ENTRY]);
    api.memoryAppend.mockResolvedValue(GLOBAL_ENTRY);
    api.memorySave.mockResolvedValue(GLOBAL_ENTRY);
    api.memoryFlush.mockResolvedValue(undefined);
    api.memoryDream.mockResolvedValue(undefined);
    api.memoryRewrite.mockResolvedValue("# Global\n\nRewritten");
    vi.stubGlobal("confirm", vi.fn(() => true));
  });

  it("列出 Runtime 记忆，会话日志只读", async () => {
    render(<ResourcesPanel cwd="/repo" sessionId="session-1" />);

    expect(await screen.findByText("2026-08-31-session.md")).toBeInTheDocument();
    expect(screen.getByText("会话记录")).toBeInTheDocument();
    expect(screen.getAllByTitle("删除")).toHaveLength(1);

    fireEvent.click(screen.getByTitle("查看"));
    expect(screen.getByDisplayValue("# Session log")).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: "保存" })).not.toBeInTheDocument();
  });

  it("落盘携带当前会话 ID", async () => {
    render(<ResourcesPanel cwd="/repo" sessionId="session-1" />);
    await screen.findByText("MEMORY.md");

    fireEvent.click(screen.getByRole("button", { name: "落盘" }));
    await waitFor(() => expect(api.memoryFlush).toHaveBeenCalledWith("session-1"));
  });

  it("新建记忆追加到工作区主文件", async () => {
    const user = userEvent.setup();
    render(<ResourcesPanel cwd="/repo" sessionId="session-1" />);
    await screen.findByText("MEMORY.md");

    await user.click(screen.getByRole("button", { name: /添加一条记忆/ }));
    await user.type(screen.getByPlaceholderText(/TypeScript/), "优先写测试");
    await user.click(screen.getByRole("button", { name: "添加" }));

    await waitFor(() => {
      expect(api.memoryAppend).toHaveBeenCalledWith("workspace", "优先写测试", "/repo");
    });
  });

  it("AI 整理只更新草稿，保存时带修订号", async () => {
    const user = userEvent.setup();
    render(<ResourcesPanel cwd="/repo" sessionId="session-1" />);
    await screen.findByText("MEMORY.md");

    await user.click(screen.getByTitle("编辑"));
    await user.click(screen.getByRole("button", { name: "AI 整理" }));
    await waitFor(() => {
      expect(api.memoryRewrite).toHaveBeenCalledWith(
        "session-1",
        "# Global\n\nOriginal",
        "全局记忆 MEMORY.md",
      );
    });
    const editor = document.querySelector(".memory-editor__content") as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toBe("# Global\n\nRewritten"));
    expect(api.memorySave).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => {
      expect(api.memorySave).toHaveBeenCalledWith(
        "global",
        "MEMORY.md",
        "# Global\n\nRewritten",
        "/repo",
        "rev-global",
      );
    });
  });
});
