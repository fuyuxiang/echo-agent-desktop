import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
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
import { usePermissionModeStore } from "@/stores/permission-mode-store";
import { usePermissionStore } from "@/stores/permission-store";
import { useSessionsStore } from "@/stores/sessions-store";
import type { PermissionRequest } from "@/lib/types";
import type { SessionSummary } from "@/lib/types";

function makePermission(requestId: string, sessionId: string): PermissionRequest {
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
    mocks.permissionModeGet.mockReset().mockResolvedValue({
      permissionMode: "ask",
      configuredPermissionMode: "ask",
      autoModeAvailable: true,
    });
    mocks.permissionModeSet.mockReset();
    usePermissionModeStore.setState({ mode: "ask" });
    usePermissionStore.setState({ queues: {}, closedRequestIds: [] });
    useSessionsStore.setState({ independent: [], pendingSessionPatches: {} });
  });

  it("切换始终允许后使用后端确认的模式并告知已处理审批", async () => {
    usePermissionStore.getState().request(makePermission("permission-1", "session-1"));
    useSessionsStore.setState({
      independent: [{
        sessionId: "session-1",
        status: "awaiting_permission",
        cwd: "/workspace",
      } as SessionSummary],
    });
    mocks.permissionModeSet.mockResolvedValue({
      permissionMode: "always-approve",
      agentRunning: true,
      runtimeSynced: true,
      resolvedPending: 1,
      remainingPending: 0,
      resolvedPermissions: [
        { requestId: "permission-1", sessionId: "session-1" },
      ],
    });
    const onToast = vi.fn();
    const user = userEvent.setup();
    render(<PermissionPicker onToast={onToast} />);

    await waitFor(() => expect(mocks.permissionModeGet).toHaveBeenCalledOnce());
    await user.click(screen.getByRole("button", { name: /审批模式/ }));
    await user.click(screen.getByRole("menuitemradio", { name: /始终允许/ }));

    await waitFor(() => {
      expect(mocks.permissionModeSet).toHaveBeenCalledWith("always-approve");
      expect(usePermissionModeStore.getState().mode).toBe("always-approve");
      expect(usePermissionStore.getState().queues["session-1"]).toHaveLength(0);
      expect(usePermissionStore.getState().closedRequestIds).toContain("permission-1");
      expect(useSessionsStore.getState().independent[0].status).toBe("working");
    });
    expect(onToast).toHaveBeenCalledWith(
      "已切换为“始终允许”，并自动处理 1 个等待授权操作",
    );
  });

  it("运行时同步未确认时给出非阻断提示", async () => {
    mocks.permissionModeSet.mockResolvedValue({
      permissionMode: "always-approve",
      agentRunning: true,
      runtimeSynced: false,
      resolvedPending: 0,
      remainingPending: 0,
      resolvedPermissions: [],
    });
    const onToast = vi.fn();
    const user = userEvent.setup();
    render(<PermissionPicker onToast={onToast} />);

    await user.click(await screen.findByRole("button", { name: /审批模式/ }));
    await user.click(screen.getByRole("menuitemradio", { name: /始终允许/ }));

    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith(
        "已切换为“始终允许”，运行时未确认同步，桌面端仍会自动处理审批",
      ),
    );
  });

  it("自动模式被策略关闭时显示原因并禁止伪切换", async () => {
    mocks.permissionModeGet.mockResolvedValue({
      permissionMode: "ask",
      configuredPermissionMode: "auto",
      autoModeAvailable: false,
      autoModeUnavailableReason: "自动模式已被组织策略关闭",
    });
    const user = userEvent.setup();
    render(<PermissionPicker />);

    await waitFor(() => expect(usePermissionModeStore.getState().mode).toBe("ask"));
    await user.click(screen.getByRole("button", { name: /审批模式/ }));

    const autoOption = await screen.findByRole("menuitemradio", {
      name: /自动模式（不可用）/,
    });
    expect(autoOption).toBeDisabled();
    expect(screen.getByText("自动模式已被组织策略关闭")).toBeInTheDocument();
    expect(mocks.permissionModeSet).not.toHaveBeenCalled();
  });

  it("切换自动模式时说明已等待的授权仍需确认", async () => {
    mocks.permissionModeSet.mockResolvedValue({
      permissionMode: "auto",
      agentRunning: true,
      runtimeSynced: true,
      resolvedPending: 0,
      remainingPending: 1,
      resolvedPermissions: [],
    });
    const onToast = vi.fn();
    const user = userEvent.setup();
    render(<PermissionPicker onToast={onToast} />);

    await waitFor(() => expect(mocks.permissionModeGet).toHaveBeenCalledOnce());
    await user.click(screen.getByRole("button", { name: /审批模式/ }));
    await user.click(screen.getByRole("menuitemradio", { name: /^自动模式/ }));

    await waitFor(() => {
      expect(usePermissionModeStore.getState().mode).toBe("auto");
      expect(onToast).toHaveBeenCalledWith(
        "已切换为“自动模式”，将应用于后续操作，当前 1 个等待授权操作仍需你确认",
      );
    });
  });

  it("自动模式未获得运行时确认时不误报当前会话已生效", async () => {
    mocks.permissionModeSet.mockResolvedValue({
      permissionMode: "auto",
      agentRunning: true,
      runtimeSynced: false,
      resolvedPending: 0,
      remainingPending: 0,
      resolvedPermissions: [],
    });
    const onToast = vi.fn();
    const user = userEvent.setup();
    render(<PermissionPicker onToast={onToast} />);

    await waitFor(() => expect(mocks.permissionModeGet).toHaveBeenCalledOnce());
    await user.click(screen.getByRole("button", { name: /审批模式/ }));
    await user.click(screen.getByRole("menuitemradio", { name: /^自动模式/ }));

    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith(
        "已保存为“自动模式”，运行中会话未确认切换，新建或重新打开会话后生效",
      ),
    );
  });

  it("能力读取失败时仍由后端阻止不可用的自动模式", async () => {
    mocks.permissionModeGet.mockRejectedValue(new Error("temporary read failure"));
    mocks.permissionModeSet.mockRejectedValue(
      new Error("自动模式已被本机配置、环境设置或组织策略关闭"),
    );
    const onToast = vi.fn();
    const user = userEvent.setup();
    render(<PermissionPicker onToast={onToast} />);

    await waitFor(() => expect(mocks.permissionModeGet).toHaveBeenCalledOnce());
    await user.click(screen.getByRole("button", { name: /审批模式/ }));
    await user.click(screen.getByRole("menuitemradio", { name: /^自动模式/ }));

    await waitFor(() => {
      expect(usePermissionModeStore.getState().mode).toBe("ask");
      expect(onToast).toHaveBeenCalledWith(
        "权限模式切换失败：自动模式已被本机配置、环境设置或组织策略关闭",
      );
    });
  });

  it("延迟的初始读取不会覆盖用户刚完成的切换", async () => {
    let resolveInitialRead: ((status: {
      permissionMode: "ask";
      configuredPermissionMode: "ask";
      autoModeAvailable: true;
    }) => void) | undefined;
    mocks.permissionModeGet.mockImplementation(
      () => new Promise((resolve) => { resolveInitialRead = resolve; }),
    );
    mocks.permissionModeSet.mockResolvedValue({
      permissionMode: "always-approve",
      agentRunning: true,
      runtimeSynced: true,
      resolvedPending: 0,
      remainingPending: 0,
      resolvedPermissions: [],
    });
    const user = userEvent.setup();
    render(<PermissionPicker />);

    await user.click(screen.getByRole("button", { name: /审批模式/ }));
    await user.click(screen.getByRole("menuitemradio", { name: /始终允许/ }));
    await waitFor(() =>
      expect(usePermissionModeStore.getState().mode).toBe("always-approve"),
    );

    await act(async () => resolveInitialRead?.({
      permissionMode: "ask",
      configuredPermissionMode: "ask",
      autoModeAvailable: true,
    }));
    expect(usePermissionModeStore.getState().mode).toBe("always-approve");
  });
});
