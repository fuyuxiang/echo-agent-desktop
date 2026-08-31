import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgAskEvent } from "@/lib/org-client";

const api = vi.hoisted(() => ({
  orgSession: vi.fn(),
  orgLogin: vi.fn(),
  orgLogout: vi.fn(),
  orgListScopes: vi.fn(),
  orgListDocuments: vi.fn(),
  orgListSkills: vi.fn(),
  orgDocumentSubmissionsMine: vi.fn(),
  orgSkillSubmissionsMine: vi.fn(),
  orgAskStart: vi.fn(),
  orgAskCancel: vi.fn(),
  orgFetchDocument: vi.fn(),
  orgSubmitDocument: vi.fn(),
  orgArchiveDocument: vi.fn(),
  orgNewDocumentVersion: vi.fn(),
  orgPublishDocument: vi.fn(),
  orgQaFeedback: vi.fn(),
  orgSetSkillPreference: vi.fn(),
  orgPublishSkill: vi.fn(),
  orgSubmitSkill: vi.fn(),
  orgSyncSkills: vi.fn(),
  listenOrgAsk: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@/lib/org-client", () => api);
vi.mock("../Markdown", () => ({
  Markdown: ({ children }: { children: string }) => <div>{children}</div>,
}));

import { OrganizationMemoryPanel } from "../OrganizationMemoryPanel";
import { resetOrgSessionMirror, useOrgSessionStore } from "@/stores/org-session-store";

let askListener: ((event: OrgAskEvent) => void) | undefined;

const personalScope = {
  id: "personal-scope",
  kind: "personal" as const,
  name: "我的空间",
};
const teamScope = {
  id: "team-scope",
  kind: "team" as const,
  name: "研发团队",
};

function document(id: string, title: string, scopeId: string, scopeName: string) {
  return {
    id,
    title,
    sourceType: "md",
    status: "ready" as const,
    byteSize: 128,
    scopeId,
    scopeKind: scopeId === personalScope.id ? "personal" as const : "team" as const,
    scopeName,
    chunkCount: 1,
    tags: [],
    updatedAt: 1,
  };
}

describe("OrganizationMemoryPanel", () => {
  beforeEach(() => {
    resetOrgSessionMirror();
    for (const mock of Object.values(api)) mock.mockReset();
    askListener = undefined;
    api.orgSession.mockResolvedValue({
      loggedIn: true,
      serverUrl: "https://memory.example.com",
      user: { id: "u1", username: "alice", displayName: "Alice", role: "member", clearance: 1 },
    });
    api.orgListScopes.mockResolvedValue([personalScope, teamScope]);
    api.orgListDocuments.mockResolvedValue({
      items: [
        document("d1", "个人文档", personalScope.id, personalScope.name),
        document("d2", "团队文档", teamScope.id, teamScope.name),
      ],
      total: 2,
      page: 1,
      size: 50,
    });
    api.orgListSkills.mockResolvedValue([]);
    api.orgDocumentSubmissionsMine.mockResolvedValue([]);
    api.orgSkillSubmissionsMine.mockResolvedValue([]);
    api.orgAskStart.mockResolvedValue("request-1");
    api.orgAskCancel.mockResolvedValue(true);
    api.orgLogout.mockResolvedValue(undefined);
    api.listenOrgAsk.mockImplementation(async (listener: (event: OrgAskEvent) => void) => {
      askListener = listener;
      return vi.fn();
    });
  });

  it("切换 Scope 时只显示当前范围的文档", async () => {
    render(<OrganizationMemoryPanel />);
    await screen.findByText("Alice · https://memory.example.com");
    expect(useOrgSessionStore.getState().session?.user?.displayName).toBe("Alice");

    fireEvent.click(screen.getByRole("button", { name: /^文档/ }));
    expect(screen.getByText("个人文档")).toBeInTheDocument();
    expect(screen.queryByText("团队文档")).not.toBeInTheDocument();

    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: teamScope.id } });
    expect(screen.getByText("团队文档")).toBeInTheDocument();
    expect(screen.queryByText("个人文档")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "新版本" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "归档" })).not.toBeInTheDocument();
  });

  it("刷新后若当前 Scope 已撤权则回退到仍可用的个人范围", async () => {
    render(<OrganizationMemoryPanel />);
    await screen.findByText("Alice · https://memory.example.com");
    fireEvent.click(screen.getByRole("button", { name: /^文档/ }));
    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: teamScope.id } });
    expect(screen.getByText("团队文档")).toBeInTheDocument();

    api.orgListScopes.mockResolvedValue([personalScope]);
    api.orgListDocuments.mockResolvedValue({
      items: [document("d1", "个人文档", personalScope.id, personalScope.name)],
      total: 1,
      page: 1,
      size: 50,
    });
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));

    await waitFor(() => expect(screen.getAllByRole("combobox")[0]).toHaveValue(personalScope.id));
    expect(screen.getByText("个人文档")).toBeInTheDocument();
    expect(screen.queryByText("团队文档")).not.toBeInTheDocument();
  });

  it("实时呈现 SSE 增量、引用和最终答案", async () => {
    render(<OrganizationMemoryPanel />);
    await screen.findByText("Alice · https://memory.example.com");
    fireEvent.change(screen.getByPlaceholderText("例如：公司的差旅住宿标准是什么？"), {
      target: { value: "制度是什么？" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提问" }));
    await waitFor(() => expect(api.orgAskStart).toHaveBeenCalledTimes(1));

    act(() => {
      askListener?.({ requestId: "request-1", event: "status", data: { message: "正在生成" } });
      askListener?.({
        requestId: "request-1",
        event: "citation",
        data: {
          id: "[1]",
          docId: "d2",
          chunkId: "c1",
          title: "团队制度",
          scopeKind: "team",
          quote: "制度原文",
          openUrl: "/api/v1/docs/d2/content",
          stale: false,
        },
      });
      askListener?.({ requestId: "request-1", event: "delta", data: { text: "实时答案" } });
    });
    expect(screen.getByText("实时答案")).toBeInTheDocument();
    expect(screen.getByText("制度原文")).toBeInTheDocument();

    act(() => {
      askListener?.({
        requestId: "request-1",
        event: "final",
        data: {
          answer: "最终答案",
          citations: [],
          confidence: 0.82,
          insufficient: false,
          traceId: "trace-1",
          mode: "fast",
          verification: "supported",
        },
      });
    });
    expect(screen.getByText("最终答案")).toBeInTheDocument();
    expect(screen.queryByText("实时答案")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "提问" })).toBeInTheDocument();
  });

  it("无页码引用也能查看整篇原文", async () => {
    api.orgFetchDocument.mockResolvedValue({ docId: "d2", text: "完整制度原文", chunks: [] });
    render(<OrganizationMemoryPanel />);
    await screen.findByText("Alice · https://memory.example.com");
    fireEvent.change(screen.getByPlaceholderText("例如：公司的差旅住宿标准是什么？"), {
      target: { value: "制度是什么？" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提问" }));
    await waitFor(() => expect(api.orgAskStart).toHaveBeenCalledTimes(1));

    act(() => {
      askListener?.({
        requestId: "request-1",
        event: "final",
        data: {
          answer: "最终答案",
          citations: [{
            id: "cit-1",
            docId: "d2",
            chunkId: "c1",
            title: "团队制度",
            scopeKind: "team",
            page: null,
            heading: "",
            quote: "制度原文",
            openUrl: "echo://doc/d2",
            stale: false,
          }],
          confidence: 0.82,
          insufficient: false,
          traceId: "trace-1",
          mode: "fast",
          verification: "supported",
        },
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "查看原文" }));
    await waitFor(() => expect(api.orgFetchDocument).toHaveBeenCalledWith("d2", undefined));
    expect(screen.getByText("完整制度原文")).toBeInTheDocument();
  });

  it("组织 Skill 点击安装后写入用户安装偏好", async () => {
    api.orgListSkills.mockResolvedValue([{
      skillId: "skill-1",
      versionId: "version-1",
      name: "shared-guide",
      description: "共享指南",
      version: "1.0.0",
      scopeId: personalScope.id,
      scopeKind: "personal",
      scopeName: personalScope.name,
      mandatory: false,
      allowPersonalOverride: true,
      enabled: false,
      updatedAt: 1,
    }]);
    api.orgSetSkillPreference.mockResolvedValue({ skillId: "skill-1", enabled: true });

    render(<OrganizationMemoryPanel />);
    await screen.findByText("Alice · https://memory.example.com");
    fireEvent.click(screen.getByRole("button", { name: /^Skills/ }));
    fireEvent.click(await screen.findByRole("button", { name: "安装" }));

    await waitFor(() => expect(api.orgSetSkillPreference).toHaveBeenCalledWith("skill-1", true));
  });

  it("停止后忽略迟到的最终事件", async () => {
    render(<OrganizationMemoryPanel />);
    await screen.findByText("Alice · https://memory.example.com");
    fireEvent.change(screen.getByPlaceholderText("例如：公司的差旅住宿标准是什么？"), {
      target: { value: "停止这个问题" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提问" }));
    await screen.findByRole("button", { name: "停止" });
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    await waitFor(() => expect(api.orgAskCancel).toHaveBeenCalledWith("request-1"));

    act(() => {
      askListener?.({
        requestId: "request-1",
        event: "final",
        data: {
          answer: "不应出现的迟到答案",
          citations: [],
          confidence: 1,
          insufficient: false,
          traceId: "late",
          mode: "fast",
          verification: "supported",
        },
      });
    });
    expect(screen.queryByText("不应出现的迟到答案")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "提问" })).toBeInTheDocument();
  });

  it("本地清理告警也不会让退出后的旧工作区继续可见", async () => {
    api.orgLogout.mockRejectedValue(new Error("keychain cleanup failed"));
    render(<OrganizationMemoryPanel />);
    await screen.findByText("Alice · https://memory.example.com");
    fireEvent.click(screen.getByRole("button", { name: "退出组织" }));

    await screen.findByRole("heading", { name: "连接组织" });
    expect(screen.queryByText("Alice · https://memory.example.com")).not.toBeInTheDocument();
    expect(screen.getByText(/keychain cleanup failed/)).toBeInTheDocument();
  });

  it("服务器注销尚未返回时立即隐藏旧工作区", async () => {
    let finishLogout: (() => void) | undefined;
    api.orgLogout.mockImplementation(() => new Promise<void>((resolve) => {
      finishLogout = resolve;
    }));
    render(<OrganizationMemoryPanel />);
    await screen.findByText("Alice · https://memory.example.com");
    fireEvent.click(screen.getByRole("button", { name: "退出组织" }));

    expect(screen.getByRole("heading", { name: "连接组织" })).toBeInTheDocument();
    expect(screen.queryByText("Alice · https://memory.example.com")).not.toBeInTheDocument();
    expect(useOrgSessionStore.getState().session?.loggedIn).toBe(false);
    await act(async () => finishLogout?.());
  });

  it("监听器在异步注册期间卸载也会释放", async () => {
    let resolveListener: ((stop: () => void) => void) | undefined;
    const stop = vi.fn();
    api.listenOrgAsk.mockImplementation(() => new Promise((resolve) => {
      resolveListener = resolve;
    }));
    const view = render(<OrganizationMemoryPanel />);
    view.unmount();
    await act(async () => resolveListener?.(stop));
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
