import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { KnowledgePicker } from "../KnowledgePicker";
import { registerKbProvider, resetKbRegistry } from "@/lib/knowledge-base";
import { useKnowledgeStore } from "@/stores/knowledge-store";
import { resetOrgSessionMirror, useOrgSessionStore } from "@/stores/org-session-store";

const setKnowledgeSourcesMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/agent-client", () => ({
  agentSetKnowledgeSources: setKnowledgeSourcesMock,
}));

describe("KnowledgePicker", () => {
  beforeEach(() => {
    resetKbRegistry();
    resetOrgSessionMirror();
    setKnowledgeSourcesMock.mockReset();
    setKnowledgeSourcesMock.mockResolvedValue({
      personalSelected: false,
      organizationSelected: false,
      personalAttached: false,
      organizationAttached: false,
    });
    useKnowledgeStore.setState({
      defaultSources: [],
      sessionSources: {},
      sourceCount: 0,
      retrievals: {},
      turnTraces: {},
    });
  });

  it("未配置个人知识时解释原因并进入管理页", () => {
    const onManage = vi.fn();
    render(<KnowledgePicker onManage={onManage} />);
    fireEvent.click(screen.getByRole("button", { name: "知识来源，未选择" }));
    const personal = screen.getByRole("menuitemcheckbox", { name: /个人知识库/ });
    expect(personal).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(personal);
    expect(onManage).toHaveBeenCalledOnce();
  });

  it("支持为当前任务多选和取消知识来源", async () => {
    registerKbProvider({ id: "local", label: "本地：notes", isEnabled: () => true, list: () => [] });
    useKnowledgeStore.getState().setSourceCount(1);
    useOrgSessionStore.setState({
      hydrated: true,
      session: {
        loggedIn: true,
        organizationMemoryEnabled: true,
        bootstrap: {
          apiVersion: 1,
          user: { id: "u1", username: "u1", displayName: "用户", role: "member", clearance: 1 },
          scopes: [{ id: "team-1", kind: "team", name: "产品团队" }],
          policy: {},
          serverTime: Date.now(),
        },
      },
    });
    render(<KnowledgePicker sessionId="session-1" />);

    fireEvent.click(screen.getByRole("button", { name: "知识来源，未选择" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /个人知识库/ }));
    await waitFor(() => expect(screen.getByRole("menuitemcheckbox", { name: /组织知识库/ })).toBeEnabled());
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /组织知识库/ }));

    await waitFor(() => expect(useKnowledgeStore.getState().sessionSources["session-1"]).toEqual([
      "personal", "organization",
    ]));
    expect(screen.getByRole("button", { name: "知识来源 2" })).toBeInTheDocument();
    expect(setKnowledgeSourcesMock).toHaveBeenLastCalledWith("session-1", [
      "personal",
      "organization",
    ]);

    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /个人知识库/ }));
    await waitFor(() => expect(useKnowledgeStore.getState().sessionSources["session-1"])
      .toEqual(["organization"]));
  });

  it("原生同步失败时回滚勾选并告知用户", async () => {
    const onToast = vi.fn();
    registerKbProvider({ id: "local", label: "本地：notes", isEnabled: () => true, list: () => [] });
    useKnowledgeStore.getState().setSourceCount(1);
    setKnowledgeSourcesMock.mockRejectedValueOnce(new Error("MCP 连接超时"));
    render(<KnowledgePicker sessionId="session-failed" onToast={onToast} />);

    fireEvent.click(screen.getByRole("button", { name: "知识来源，未选择" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /个人知识库/ }));

    await waitFor(() => expect(useKnowledgeStore.getState().sessionSources["session-failed"])
      .toEqual([]));
    expect(onToast).toHaveBeenCalledWith(expect.stringContaining("已恢复上一选择"));
  });

  it("组织未登录时不可选择，并提供明确入口", () => {
    const onOpenOrganization = vi.fn();
    useOrgSessionStore.setState({ hydrated: true, session: { loggedIn: false } });
    render(<KnowledgePicker onOpenOrganization={onOpenOrganization} />);

    fireEvent.click(screen.getByRole("button", { name: "知识来源，未选择" }));
    const organization = screen.getByRole("menuitemcheckbox", { name: /组织知识库/ });
    expect(organization).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("登录组织后可用")).toBeInTheDocument();
    fireEvent.click(organization);
    expect(useKnowledgeStore.getState().defaultSources).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "登录组织" }));
    expect(onOpenOrganization).toHaveBeenCalledOnce();
  });
});
