import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Mock native filesystem picker + tauri-kb-reader so the secure backend-owned
// selection flow remains testable outside Tauri.
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock("@/lib/tauri-kb-reader", () => ({
  isTauriAvailable: () => true,
  createTauriDirectoryReader: () => ({
    listDir: async () => [],
    readText: async () => null,
  }),
}));

import { KnowledgeBasePanel } from "../KnowledgeBasePanel";
import { registerKbProvider, resetKbRegistry, listKbProviders, unregisterKbProvider } from "@/lib/knowledge-base";

describe("KnowledgeBasePanel", () => {
  beforeEach(() => {
    resetKbRegistry();
    localStorage.removeItem("echoagent.knowledge-sources.v1");
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it("无 provider 显示未配置", async () => {
    await act(async () => {
      render(<KnowledgeBasePanel />);
    });
    expect(screen.getByText("未配置知识源")).toBeInTheDocument();
  });

  it("有 provider 显示源数与名称", async () => {
    registerKbProvider({
      id: "local",
      label: "本地文件夹",
      isEnabled: () => true,
      list: () => [{ id: "1", title: "笔记" }],
    });
    render(<KnowledgeBasePanel />);
    // 源摘要「1 个源」(异步加载)。
    await waitFor(() => expect(screen.getByText(/1 个源/)).toBeInTheDocument());
    // 添加按钮存在。
    expect(screen.getByRole("button", { name: /添加本地文件夹/ })).toBeInTheDocument();
  });

  it("搜索命中显示结果(source + title)", async () => {
    registerKbProvider({
      id: "docs",
      label: "文档库",
      isEnabled: () => true,
      list: (q) =>
        q
          ? [{ id: "1", title: "React 指南", snippet: " Hooks" }].filter((e) =>
              e.title.includes(q),
            )
          : [{ id: "1", title: "React 指南" }],
    });
    render(<KnowledgeBasePanel />);
    fireEvent.change(screen.getByRole("textbox", { name: "搜索知识库" }), {
      target: { value: "React" },
    });
    await waitFor(() => expect(screen.getByText("React 指南")).toBeInTheDocument());
    expect(screen.getByText("docs")).toBeInTheDocument();
  });

  it("搜索无匹配显示空态", async () => {
    registerKbProvider({
      id: "docs",
      label: "文档库",
      isEnabled: () => true,
      list: () => [],
    });
    render(<KnowledgeBasePanel />);
    fireEvent.change(screen.getByRole("textbox", { name: "搜索知识库" }), {
      target: { value: "不存在" },
    });
    await waitFor(() => expect(screen.getByText("无匹配结果")).toBeInTheDocument());
  });

  it("搜索结果是键盘可达的原生按钮", async () => {
    const onOpen = vi.fn();
    const user = userEvent.setup();
    registerKbProvider({
      id: "docs",
      label: "文档库",
      isEnabled: () => true,
      list: () => [{ id: "9", title: "T", url: "https://x/9" }],
    });
    render(<KnowledgeBasePanel onOpen={onOpen} />);
    fireEvent.change(screen.getByRole("textbox", { name: "搜索知识库" }), {
      target: { value: "T" },
    });
    const result = await screen.findByRole("button", { name: "打开知识条目：T" });
    result.focus();
    expect(result).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onOpen).toHaveBeenCalledWith("9", "https://x/9");
  });

  it("部分 provider 失败时保留可用结果并给出明确反馈", async () => {
    registerKbProvider({
      id: "bad",
      label: "云端文档",
      isEnabled: () => true,
      list: () => Promise.reject(new Error("连接超时")),
    });
    registerKbProvider({
      id: "good",
      label: "本地文档",
      isEnabled: () => true,
      list: () => [{ id: "ok", title: "可用结果" }],
    });
    render(<KnowledgeBasePanel />);

    fireEvent.change(screen.getByRole("textbox", { name: "搜索知识库" }), {
      target: { value: "文档" },
    });

    expect(await screen.findByRole("button", { name: "打开知识条目：可用结果" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("部分知识源搜索失败");
    expect(screen.getByRole("alert")).toHaveTextContent("云端文档：连接超时");
    expect(screen.queryByText("无匹配结果")).toBeNull();
    expect(screen.getByRole("button", { name: "重试搜索" })).toBeInTheDocument();
  });

  it("全部 provider 失败时显示可重试错误，重试成功后恢复结果", async () => {
    let attempts = 0;
    registerKbProvider({
      id: "flaky",
      label: "临时离线源",
      isEnabled: () => true,
      list: () => {
        attempts += 1;
        if (attempts === 1) return Promise.reject(new Error("索引暂不可用"));
        return [{ id: "recovered", title: "已恢复文档" }];
      },
    });
    render(<KnowledgeBasePanel />);

    fireEvent.change(screen.getByRole("textbox", { name: "搜索知识库" }), {
      target: { value: "文档" },
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("所有知识源搜索失败");
    expect(screen.queryByText("无匹配结果")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重试搜索" }));

    expect(await screen.findByRole("button", { name: "打开知识条目：已恢复文档" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("「添加本地文件夹」弹出目录选择并注册稳定 provider", async () => {
    invokeMock.mockImplementation((command: string) =>
      Promise.resolve(command === "filesystem_pick_directory" ? "/my/notes" : undefined));
    const before = listKbProviders().length;
    render(<KnowledgeBasePanel onToast={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /添加本地文件夹/ }));
    await waitFor(() => expect(listKbProviders().length).toBe(before + 1));
    expect(listKbProviders()).toEqual([
      expect.objectContaining({ id: expect.stringMatching(/^local-/), label: "本地：notes" }),
    ]);
    expect(invokeMock).toHaveBeenCalledWith("filesystem_pick_directory");
  });

  it("取消选择(返回 null)不注册 provider", async () => {
    invokeMock.mockImplementation((command: string) =>
      Promise.resolve(command === "filesystem_pick_directory" ? null : undefined));
    const before = listKbProviders().length;
    render(<KnowledgeBasePanel onToast={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /添加本地文件夹/ }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("filesystem_pick_directory"));
    expect(listKbProviders().length).toBe(before);
  });

  it("「移除知识源」按钮注销已注册 provider", async () => {
    registerKbProvider({
      id: "local",
      label: "本地文件夹",
      isEnabled: () => true,
      list: () => [],
    });
    render(<KnowledgeBasePanel onToast={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("本地文件夹")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "移除知识源 本地文件夹" }));
    await waitFor(() => expect(listKbProviders().some((s) => s.id === "local")).toBe(false));
    // 直接确认 registry 也已移除。
    expect(unregisterKbProvider("local")).toBe(false); // 已移除 → 再移除返回 false
  });

  it("「刷新索引」按钮调用 provider.rebuild 并 toast 条目数", async () => {
    const rebuild = vi.fn(async () => 5);
    registerKbProvider({
      id: "local",
      label: "本地文件夹",
      isEnabled: () => true,
      list: () => [],
      rebuild,
    });
    const onToast = vi.fn();
    render(<KnowledgeBasePanel onToast={onToast} />);
    const refreshBtn = await screen.findByRole("button", { name: /刷新索引/ });
    fireEvent.click(refreshBtn);
    await waitFor(() => expect(rebuild).toHaveBeenCalledTimes(1));
    expect(onToast).toHaveBeenCalledWith(expect.stringContaining("5 项"));
  });

  it("无知识源时不显示「刷新索引」按钮", async () => {
    await act(async () => {
      render(<KnowledgeBasePanel onToast={vi.fn()} />);
    });
    expect(screen.queryByRole("button", { name: /刷新索引/ })).toBeNull();
  });

  it("索引状态指示:显示已索引文件数 + 最近更新时间", async () => {
    registerKbProvider({
      id: "local",
      label: "本地文件夹",
      isEnabled: () => true,
      list: () => [],
      getStats: async () => ({ fileCount: 12, lastRebuiltAt: Date.now() - 60000 }),
    });
    render(<KnowledgeBasePanel onToast={vi.fn()} />);
    // 已索引 12 个文件。
    await waitFor(() => expect(screen.getByText(/已索引 12 个文件/)).toBeInTheDocument());
    // 最近更新(相对时间,1 分钟前)。
    expect(screen.getByText(/分钟前/)).toBeInTheDocument();
  });

  it("索引状态:无 fileCount 时不显示数字,无 lastRebuiltAt 时不显示时间", async () => {
    registerKbProvider({
      id: "local",
      label: "本地文件夹",
      isEnabled: () => true,
      list: () => [],
      getStats: async () => ({}),
    });
    render(<KnowledgeBasePanel onToast={vi.fn()} />);
    // fileCount 未定义 → 显示 0(求和默认)。
    await waitFor(() => expect(screen.getByText(/已索引 0 个文件/)).toBeInTheDocument());
    // 无时间。
    expect(screen.queryByText(/分钟前|小时前|刚刚|天前/)).toBeNull();
  });
});
