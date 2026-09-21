import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ orgSession: vi.fn() }));

vi.mock("@/lib/org-client", () => ({ orgSession: mocks.orgSession }));

import {
  organizationKnowledgeAvailability,
  resetOrgSessionMirror,
  useOrgSessionStore,
} from "../org-session-store";

describe("org-session-store", () => {
  beforeEach(() => {
    resetOrgSessionMirror();
    mocks.orgSession.mockReset();
  });

  it("只执行一次并发恢复并保存组织用户", async () => {
    mocks.orgSession.mockResolvedValue({
      loggedIn: true,
      serverUrl: "https://memory.example.com",
      user: {
        id: "u1",
        username: "alice",
        displayName: "Alice",
        role: "member",
        clearance: 1,
      },
    });

    const [first, second] = await Promise.all([
      useOrgSessionStore.getState().hydrate(),
      useOrgSessionStore.getState().hydrate(),
    ]);

    expect(first?.user?.displayName).toBe("Alice");
    expect(second?.user?.displayName).toBe("Alice");
    expect(mocks.orgSession).toHaveBeenCalledTimes(1);
    expect(useOrgSessionStore.getState().hydrated).toBe(true);
  });

  it("组织服务不可达不阻塞本地 Shell", async () => {
    mocks.orgSession.mockRejectedValue(new Error("offline"));

    await expect(useOrgSessionStore.getState().hydrate()).resolves.toBeNull();
    expect(useOrgSessionStore.getState().session).toBeNull();
    expect(useOrgSessionStore.getState().hydrated).toBe(true);
  });

  it("统一判定组织知识能力并绑定服务器与账号身份", () => {
    useOrgSessionStore.setState({
      hydrated: true,
      session: {
        loggedIn: true,
        organizationMemoryEnabled: true,
        serverUrl: "https://memory.example.com",
        user: { id: "u1", username: "alice", displayName: "Alice", role: "member", clearance: 1 },
        bootstrap: {
          apiVersion: 1,
          user: { id: "u1", username: "alice", displayName: "Alice", role: "member", clearance: 1 },
          scopes: [{ id: "team-1", kind: "team", name: "研发团队" }],
          policy: {},
          serverTime: 1,
        },
      },
    });

    expect(organizationKnowledgeAvailability()).toEqual({
      available: true,
      reason: "使用组织账号中你有权限的知识",
      identity: JSON.stringify(["https://memory.example.com", "u1"]),
    });
    useOrgSessionStore.getState().clearSession();
    expect(organizationKnowledgeAvailability()).toMatchObject({
      available: false,
      reason: "登录组织后可用",
      identity: "signed-out",
    });
  });
});
