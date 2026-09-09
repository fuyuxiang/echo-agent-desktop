import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mocks = vi.hoisted(() => ({
  permissionModeGet: vi.fn(),
  permissionModeSet: vi.fn(),
}));

vi.mock("@/lib/agent-client", () => ({
  permissionModeGet: (...args: unknown[]) => mocks.permissionModeGet(...args),
  permissionModeSet: (...args: unknown[]) => mocks.permissionModeSet(...args),
}));

import { PermissionPicker } from "../PermissionPicker";
import type {
  PermissionMode,
  PermissionModeSetResult,
  PermissionModeStatus,
} from "@/lib/agent-client";
import type { PermissionRequest, SessionSummary } from "@/lib/types";
import { usePermissionModeStore } from "@/stores/permission-mode-store";
import { usePermissionStore } from "@/stores/permission-store";
import { useSessionsStore } from "@/stores/sessions-store";

function modeStatus(
  sessionId?: string,
  overrides: Partial<PermissionModeStatus> = {},
): PermissionModeStatus {
  return {
    sessionId,
    permissionMode: "ask",
    configuredPermissionMode: "ask",
    autoModeAvailable: true,
    alwaysApproveAvailable: true,
    locked: false,
    runtimeSyncState: sessionId ? "synced" : "offline",
    runtimeAppliedMode: sessionId ? "ask" : undefined,
    ...overrides,
  };
}

function setResult(
  sessionId: string,
  mode: PermissionMode,
  overrides: Partial<PermissionModeSetResult> = {},
): PermissionModeSetResult {
  return {
    ...modeStatus(sessionId, {
      permissionMode: mode,
      configuredPermissionMode: mode,
      runtimeSyncState: "synced",
      runtimeAppliedMode: mode,
    }),
    agentRunning: true,
    runtimeSynced: true,
    resolvedPending: 0,
    remainingPending: 0,
    resolvedPermissions: [],
    ...overrides,
  };
}

function session(sessionId: string, permissionMode: PermissionMode = "ask"): SessionSummary {
  return {
    sessionId,
    title: sessionId,
    cwd: "/workspace",
    status: "pending",
    permissionMode,
  };
}

function permission(requestId: string, sessionId: string): PermissionRequest {
  return {
    requestId,
    sessionId,
    toolCallId: `tool-${requestId}`,
    toolKind: "edit",
    title: "Write test file",
    options: [{ optionId: "allow", kind: "allow", title: "Yes" }],
  };
}

describe("PermissionPicker", () => {
  beforeEach(() => {
    mocks.permissionModeGet.mockReset().mockResolvedValue(modeStatus());
    mocks.permissionModeSet.mockReset();
    usePermissionModeStore.setState({
      homeMode: "ask",
      statuses: {},
      capabilityStatus: null,
    });
    usePermissionStore.setState({ queues: {}, closedRequestIds: [] });
    useSessionsStore.setState({ independent: [], pendingSessionPatches: {} });
  });

  it("首页选择只修改待创建任务，不调用后端也不改其他任务", async () => {
    usePermissionModeStore.getState().setStatus(modeStatus("other", {
      permissionMode: "always-approve",
      configuredPermissionMode: "always-approve",
      runtimeAppliedMode: "always-approve",
    }));
    const onToast = vi.fn();
    const user = userEvent.setup();
    render(<PermissionPicker onToast={onToast} />);

    await waitFor(() => expect(mocks.permissionModeGet).toHaveBeenCalledWith(undefined));
    await user.click(screen.getByRole("button", { name: /审批模式/ }));
    await user.click(screen.getByRole("menuitemradio", { name: /^自动模式/ }));

    expect(usePermissionModeStore.getState().homeMode).toBe("auto");
    expect(usePermissionModeStore.getState().statuses.other.permissionMode)
      .toBe("always-approve");
    expect(mocks.permissionModeSet).not.toHaveBeenCalled();
    expect(onToast).toHaveBeenCalledWith("本任务将使用“自动模式”");
  });

  it("已有任务仅定向切换当前 session，已弹出的审批保持待处理", async () => {
    useSessionsStore.setState({ independent: [session("session-1"), session("session-2")] });
    usePermissionModeStore.getState().setStatus(modeStatus("session-2"));
    usePermissionStore.getState().request(permission("permission-1", "session-1"));
    mocks.permissionModeGet.mockResolvedValue(modeStatus("session-1"));
    mocks.permissionModeSet.mockResolvedValue(setResult("session-1", "auto", {
      remainingPending: 1,
    }));
    const onToast = vi.fn();
    const user = userEvent.setup();
    render(<PermissionPicker sessionId="session-1" onToast={onToast} />);

    await waitFor(() => expect(mocks.permissionModeGet).toHaveBeenCalledWith("session-1"));
    await user.click(screen.getByRole("button", { name: /审批模式/ }));
    expect(screen.getByText("仅影响当前任务，其他任务保持不变")).toBeInTheDocument();
    await user.click(screen.getByRole("menuitemradio", { name: /^自动模式/ }));

    await waitFor(() => expect(mocks.permissionModeSet)
      .toHaveBeenCalledWith("session-1", "auto"));
    expect(usePermissionModeStore.getState().statuses["session-1"].permissionMode).toBe("auto");
    expect(usePermissionModeStore.getState().statuses["session-2"].permissionMode).toBe("ask");
    expect(useSessionsStore.getState().independent.find((item) => item.sessionId === "session-1")?.permissionMode)
      .toBe("auto");
    expect(useSessionsStore.getState().independent.find((item) => item.sessionId === "session-2")?.permissionMode)
      .toBe("ask");
    expect(usePermissionStore.getState().queues["session-1"]).toHaveLength(1);
    expect(usePermissionStore.getState().closedRequestIds).toEqual([]);
    expect(onToast).toHaveBeenCalledWith(
      "当前任务已切换为“自动模式”，当前 1 个待审批操作仍需你确认",
    );
  });

  it("提高为本任务始终允许前要求明确确认", async () => {
    useSessionsStore.setState({ independent: [session("session-1")] });
    mocks.permissionModeGet.mockResolvedValue(modeStatus("session-1"));
    mocks.permissionModeSet.mockResolvedValue(setResult("session-1", "always-approve"));
    const user = userEvent.setup();
    render(<PermissionPicker sessionId="session-1" />);

    await user.click(await screen.findByRole("button", { name: /审批模式/ }));
    await user.click(screen.getByRole("menuitemradio", { name: /^本任务始终允许/ }));

    const dialog = screen.getByRole("alertdialog", { name: "确认本任务始终允许" });
    expect(within(dialog).getByText(/已经弹出的待审批操作不会被自动批准/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "取消" })).toHaveFocus();
    expect(mocks.permissionModeSet).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "仅当前任务始终允许" }));
    await waitFor(() => expect(mocks.permissionModeSet)
      .toHaveBeenCalledWith("session-1", "always-approve"));
  });

  it("组织策略锁定时展示原因并禁止任务修改", async () => {
    useSessionsStore.setState({ independent: [session("session-1")] });
    mocks.permissionModeGet.mockResolvedValue(modeStatus("session-1", {
      locked: true,
      lockedReason: "权限模式已被组织策略锁定为 ask",
    }));
    const user = userEvent.setup();
    render(<PermissionPicker sessionId="session-1" />);

    await waitFor(() => expect(usePermissionModeStore.getState().statuses["session-1"]?.locked)
      .toBe(true));
    await user.click(screen.getByRole("button", { name: /审批模式/ }));

    expect(screen.getByText("权限模式已被组织策略锁定为 ask")).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: /^自动模式/ })).toBeDisabled();
    expect(mocks.permissionModeSet).not.toHaveBeenCalled();
  });

  it("能力变化会将首页不再可用的草稿权限安全回退为审批模式", async () => {
    usePermissionModeStore.setState({ homeMode: "auto" });
    mocks.permissionModeGet.mockResolvedValue(modeStatus(undefined, {
      autoModeAvailable: false,
      autoModeUnavailableReason: "自动模式已被组织策略关闭",
    }));
    render(<PermissionPicker />);

    await waitFor(() => expect(usePermissionModeStore.getState().homeMode).toBe("ask"));
    expect(screen.getByRole("button", { name: /审批模式/ })).toBeInTheDocument();
  });

  it("延迟的初始读取不会覆盖用户刚完成的任务切换", async () => {
    let resolveInitialRead: ((value: PermissionModeStatus) => void) | undefined;
    useSessionsStore.setState({ independent: [session("session-1")] });
    mocks.permissionModeGet.mockImplementation(() => new Promise((resolve) => {
      resolveInitialRead = resolve;
    }));
    mocks.permissionModeSet.mockResolvedValue(setResult("session-1", "auto"));
    const user = userEvent.setup();
    render(<PermissionPicker sessionId="session-1" />);

    await user.click(screen.getByRole("button", { name: /审批模式/ }));
    await user.click(screen.getByRole("menuitemradio", { name: /^自动模式/ }));
    await waitFor(() => expect(usePermissionModeStore.getState().statuses["session-1"]?.permissionMode)
      .toBe("auto"));

    await act(async () => resolveInitialRead?.(modeStatus("session-1")));
    expect(usePermissionModeStore.getState().statuses["session-1"].permissionMode).toBe("auto");
  });

  it("后端拒绝切换时保留原权限并给出可理解的错误", async () => {
    useSessionsStore.setState({ independent: [session("session-1")] });
    mocks.permissionModeGet.mockResolvedValue(modeStatus("session-1"));
    mocks.permissionModeSet.mockRejectedValue(new Error("自动模式已被组织策略关闭"));
    const onToast = vi.fn();
    const user = userEvent.setup();
    render(<PermissionPicker sessionId="session-1" onToast={onToast} />);

    await waitFor(() => expect(usePermissionModeStore.getState().statuses["session-1"])
      .toBeDefined());
    await user.click(screen.getByRole("button", { name: /审批模式/ }));
    await user.click(screen.getByRole("menuitemradio", { name: /^自动模式/ }));

    await waitFor(() => expect(onToast)
      .toHaveBeenCalledWith("权限模式切换失败：自动模式已被组织策略关闭"));
    expect(useSessionsStore.getState().independent[0].permissionMode).toBe("ask");
    expect(usePermissionModeStore.getState().statuses["session-1"].permissionMode).toBe("ask");
  });
});
