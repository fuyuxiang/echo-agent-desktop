import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  orgSession: vi.fn(), orgLogin: vi.fn(), orgLogout: vi.fn(),
  orgMemoryPromotionsMine: vi.fn(), orgListScopes: vi.fn(), orgListDocuments: vi.fn(),
  orgListMemories: vi.fn(), orgListSkills: vi.fn(), orgDocumentSubmissionsMine: vi.fn(),
  orgSkillSubmissionsMine: vi.fn(), orgSubmitDocument: vi.fn(), orgSubmitMemoryCandidate: vi.fn(),
  orgArchiveDocument: vi.fn(), orgNewDocumentVersion: vi.fn(), orgPublishDocument: vi.fn(),
  orgSetSkillPreference: vi.fn(), orgPublishSkill: vi.fn(), orgSubmitSkill: vi.fn(), orgSyncSkills: vi.fn(),
}));
vi.mock("@/lib/org-client", () => api);
const agentClientMocks = vi.hoisted(() => ({ filesystemPickFiles: vi.fn(async () => []) }));
vi.mock("@/lib/agent-client", () => agentClientMocks);

import { OrganizationMemoryPanel } from "../OrganizationMemoryPanel";
import { resetOrgSessionMirror, useOrgSessionStore } from "@/stores/org-session-store";
import { filesystemPickFiles } from "@/lib/agent-client";

const personalScope = { id: "personal-scope", kind: "personal" as const, name: "我的空间" };
const teamScope = { id: "team-scope", kind: "team" as const, name: "研发团队" };

function document(id: string, title: string, scopeId: string, scopeName: string) {
  return {
    id, title, sourceType: "md", status: "ready" as const, byteSize: 128, scopeId,
    scopeKind: scopeId === personalScope.id ? "personal" as const : "team" as const,
    scopeName, chunkCount: 1, tags: [], updatedAt: 1,
  };
}

function mockWorkspace() {
  api.orgSession.mockResolvedValue({
    loggedIn: true, organizationMemoryEnabled: true, serverUrl: "https://memory.example.com",
    user: { id: "u1", username: "alice", displayName: "Alice", role: "member", clearance: 1 },
    bootstrap: {
      apiVersion: 1,
      user: { id: "u1", username: "alice", displayName: "Alice", role: "member", clearance: 1 },
      scopes: [personalScope, teamScope], policy: { allowSkillSubmission: true, allowPersonalCloud: true }, serverTime: 1,
    },
  });
  api.orgListScopes.mockResolvedValue([personalScope, teamScope]);
  api.orgListDocuments.mockResolvedValue({
    items: [document("d1", "个人文档", personalScope.id, personalScope.name), document("d2", "团队文档", teamScope.id, teamScope.name)],
    total: 2, page: 1, size: 50,
  });
  api.orgListSkills.mockResolvedValue([]);
  api.orgListMemories.mockResolvedValue([]);
  api.orgMemoryPromotionsMine.mockResolvedValue([]);
  api.orgDocumentSubmissionsMine.mockResolvedValue([]);
  api.orgSkillSubmissionsMine.mockResolvedValue([]);
  api.orgLogout.mockResolvedValue(undefined);
  api.orgSubmitMemoryCandidate.mockResolvedValue({ promotionId: "p1", state: "pending" });
}

describe("OrganizationMemoryPanel", () => {
  beforeEach(() => {
    resetOrgSessionMirror();
    for (const mock of Object.values(api)) mock.mockReset();
    for (const mock of Object.values(agentClientMocks)) mock.mockReset();
    agentClientMocks.filesystemPickFiles.mockResolvedValue([]);
    mockWorkspace();
  });

  it("登录凭据失效后回填服务器和账号，只要求重新输入密码", async () => {
    api.orgSession.mockResolvedValue({
      loggedIn: false,
      organizationMemoryEnabled: false,
      serverUrl: "https://memory.example.com",
      username: "alice",
      requiresReauthentication: true,
    });

    render(<OrganizationMemoryPanel />);

    expect(await screen.findByLabelText("服务器地址")).toHaveValue("https://memory.example.com");
    expect(screen.getByLabelText("账号")).toHaveValue("alice");
    expect(screen.getByLabelText("密码")).toHaveValue("");
    expect(screen.getByText("登录状态已过期，服务器和账号已为你保留，请重新输入密码。")).toBeInTheDocument();
    expect(api.orgListScopes).not.toHaveBeenCalled();
  });

  it("登录后进入管理概览且不再提供独立组织问答", async () => {
    const onStartConversation = vi.fn();
    render(<OrganizationMemoryPanel onStartConversation={onStartConversation} />);
    await screen.findByText("Alice · https://memory.example.com");
    expect(screen.getByRole("heading", { name: "组织知识" })).toBeInTheDocument();
    expect(screen.getByText("在对话中使用组织知识")).toBeInTheDocument();
    expect(screen.queryByText("组织问答")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "发起对话" }));
    expect(onStartConversation).toHaveBeenCalledOnce();
  });

  it("查看范围只过滤列表，不改变写入目标", async () => {
    render(<OrganizationMemoryPanel cwd="/workspace/payments" />);
    await screen.findByText("Alice · https://memory.example.com");
    fireEvent.click(screen.getByRole("button", { name: /^经验/ }));
    fireEvent.change(screen.getByLabelText("查看范围"), { target: { value: teamScope.id } });
    fireEvent.click(screen.getByRole("button", { name: "提交经验" }));
    expect(screen.getByLabelText("发布范围")).toHaveValue(personalScope.id);
    fireEvent.change(screen.getByLabelText("发布范围"), { target: { value: teamScope.id } });
    fireEvent.change(screen.getByPlaceholderText("写成可直接指导下一次任务的明确结论或步骤"), { target: { value: "发布前先验证回滚脚本" } });
    fireEvent.click(screen.getByRole("button", { name: "提交审核" }));
    await waitFor(() => expect(api.orgSubmitMemoryCandidate).toHaveBeenCalledWith(expect.objectContaining({
      targetScopeId: teamScope.id, content: "发布前先验证回滚脚本", workspaceRef: "/workspace/payments",
    })));
  });

  it("切换查看范围时只显示当前范围文档", async () => {
    render(<OrganizationMemoryPanel />);
    await screen.findByText("Alice · https://memory.example.com");
    fireEvent.click(screen.getByRole("button", { name: /^文档/ }));
    expect(screen.getByText("个人文档")).toBeInTheDocument();
    expect(screen.getByText("团队文档")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("查看范围"), { target: { value: teamScope.id } });
    expect(screen.getByText("团队文档")).toBeInTheDocument();
    expect(screen.queryByText("个人文档")).not.toBeInTheDocument();
  });

  it("写入范围为团队时仍可为个人文档选择副本发布目标", async () => {
    render(<OrganizationMemoryPanel />);
    await screen.findByText("Alice · https://memory.example.com");
    fireEvent.click(screen.getByRole("button", { name: /^文档/ }));
    fireEvent.change(screen.getByLabelText("文档上传范围"), { target: { value: teamScope.id } });

    expect(screen.getByLabelText("文档副本发布目标")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发布副本" })).toBeEnabled();
  });

  it("组织上下文不可用时禁用发起对话但保留管理页", async () => {
    api.orgSession.mockResolvedValue({
      loggedIn: true, organizationMemoryEnabled: false, serverUrl: "https://memory.example.com",
      user: { id: "u1", username: "alice", displayName: "Alice", role: "member", clearance: 1 },
      bootstrap: { apiVersion: 1, user: { id: "u1", username: "alice", displayName: "Alice", role: "member", clearance: 1 }, scopes: [personalScope], policy: {}, serverTime: 1 },
    });
    api.orgListScopes.mockResolvedValue([personalScope]);
    render(<OrganizationMemoryPanel onStartConversation={vi.fn()} />);
    expect(await screen.findByText("未加入共享组织范围")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发起对话" })).toBeDisabled();
  });

  it("组织 Skill 可以安装到当前设备", async () => {
    api.orgListSkills.mockResolvedValue([{
      skillId: "skill-1", versionId: "version-1", name: "shared-guide", description: "共享指南",
      version: "1.0.0", scopeId: personalScope.id, scopeKind: "personal", scopeName: personalScope.name,
      mandatory: false, allowPersonalOverride: true, enabled: false, updatedAt: 1,
    }]);
    api.orgSetSkillPreference.mockResolvedValue({ skillId: "skill-1", enabled: true });
    render(<OrganizationMemoryPanel />);
    await screen.findByText("Alice · https://memory.example.com");
    fireEvent.click(screen.getByRole("button", { name: /^Skills/ }));
    fireEvent.click(await screen.findByRole("button", { name: "安装" }));
    await waitFor(() => expect(api.orgSetSkillPreference).toHaveBeenCalledWith("skill-1", true));
  });

  it("概览按待处理类型展示并导航到正确工作区", async () => {
    api.orgMemoryPromotionsMine.mockResolvedValue([{
      id: "memory-pending",
      payloadType: "memory",
      payload: { kind: "howto", content: "上线前检查回滚" },
      source: "conversation",
      state: "pending",
      scopeName: teamScope.name,
      scopeKind: teamScope.kind,
      createdAt: 1,
    }]);
    api.orgDocumentSubmissionsMine.mockResolvedValue([{
      id: "document-pending",
      title: "发布手册",
      state: "pending",
      scopeId: teamScope.id,
      scopeName: teamScope.name,
      scopeKind: teamScope.kind,
      createdAt: 1,
    }]);
    api.orgSkillSubmissionsMine.mockResolvedValue([{
      id: "skill-pending",
      name: "release-check",
      state: "pending",
      scopeId: teamScope.id,
      scopeName: teamScope.name,
      scopeKind: teamScope.kind,
      createdAt: 1,
    }]);

    render(<OrganizationMemoryPanel />);
    expect(await screen.findByText("1 条经验待审核")).toBeInTheDocument();
    expect(screen.getByText("1 项文档正在审核、扫描或建立索引")).toBeInTheDocument();
    expect(screen.getByText("1 个 Skill 正在审核或扫描")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "查看经验" }));
    expect(screen.getByRole("heading", { name: "经验" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "概览" }));
    fireEvent.click(screen.getByRole("button", { name: "查看文档" }));
    expect(screen.getByRole("heading", { name: "文档" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "概览" }));
    fireEvent.click(screen.getByRole("button", { name: "查看 Skills" }));
    expect(screen.getAllByRole("heading", { name: "组织 Skills" })).toHaveLength(2);
  });

  it("经验或 Skill 待审核时持续刷新工作区状态", async () => {
    vi.useFakeTimers();
    try {
      api.orgMemoryPromotionsMine.mockResolvedValue([{
        id: "memory-polling",
        payloadType: "memory",
        payload: { kind: "fact", content: "需要等待审核" },
        source: "conversation",
        state: "pending",
        scopeName: teamScope.name,
        scopeKind: teamScope.kind,
        createdAt: 1,
      }]);
      render(<OrganizationMemoryPanel />);
      await act(async () => { await Promise.resolve(); });
      expect(api.orgMemoryPromotionsMine).toHaveBeenCalledTimes(1);

      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
      expect(api.orgMemoryPromotionsMine).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("注销请求未返回时立即隐藏旧组织数据", async () => {
    let finishLogout: (() => void) | undefined;
    api.orgLogout.mockImplementation(() => new Promise<void>((resolve) => { finishLogout = resolve; }));
    render(<OrganizationMemoryPanel />);
    await screen.findByText("Alice · https://memory.example.com");
    fireEvent.click(screen.getByRole("button", { name: "退出组织" }));
    expect(screen.getByRole("heading", { name: "连接组织" })).toBeInTheDocument();
    expect(screen.queryByText("Alice · https://memory.example.com")).not.toBeInTheDocument();
    expect(useOrgSessionStore.getState().session?.loggedIn).toBe(false);
    expect(useOrgSessionStore.getState().session).toMatchObject({
      serverUrl: "https://memory.example.com",
      username: "alice",
      requiresReauthentication: false,
    });
    expect(screen.getByLabelText("服务器地址")).toHaveValue("https://memory.example.com");
    expect(screen.getByLabelText("账号")).toHaveValue("alice");
    await act(async () => finishLogout?.());
  });

  it("文档批量上传限制为三个并发任务", async () => {
    let active = 0;
    let peak = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    api.orgSubmitDocument.mockImplementation(async (path: string) => {
      active += 1;
      peak = Math.max(peak, active);
      await gate;
      active -= 1;
      return { id: path, state: "pending" };
    });
    vi.mocked(filesystemPickFiles).mockResolvedValue(Array.from({ length: 5 }, (_, index) => `/tmp/${index}.md`));
    render(<OrganizationMemoryPanel />);
    await screen.findByText("Alice · https://memory.example.com");
    fireEvent.click(screen.getByRole("button", { name: /^文档/ }));
    fireEvent.click(screen.getByRole("button", { name: "上传文档" }));
    await waitFor(() => expect(api.orgSubmitDocument).toHaveBeenCalledTimes(3));
    expect(peak).toBe(3);
    await act(async () => release?.());
    await waitFor(() => expect(api.orgSubmitDocument).toHaveBeenCalledTimes(5));
    expect(peak).toBeLessThanOrEqual(3);
  });
});
