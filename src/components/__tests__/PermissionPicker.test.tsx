import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

  it("菜单只保留简短说明，独立授权边界放在提权确认中", async () => {
    const user = userEvent.setup();
    render(<PermissionPicker />);

    await user.click(screen.getByRole("button", { name: /请求批准/ }));
    const item = screen.getByRole("menuitemradio", { name: /^本任务免审批/ });
    expect(item).toHaveTextContent("常规工具操作不再逐次询问");
    expect(item).not.toHaveTextContent("操作电脑");
  });

  it("通过 body portal 完整展示并根据视口定位，不受卡片裁剪", async () => {
    const user = userEvent.setup();
    render(
      <div data-testid="clipping-card" style={{ overflow: "hidden" }}>
        <PermissionPicker />
      </div>,
    );
    const trigger = screen.getByRole("button", { name: /请求批准/ });
    trigger.getBoundingClientRect = () => ({
      x: 760,
      y: 520,
      top: 520,
      right: 860,
      bottom: 552,
      left: 760,
      width: 100,
      height: 32,
      toJSON: () => ({}),
    });

    await user.click(trigger);

    const menu = screen.getByRole("menu", { name: "本任务权限" });
    expect(menu.parentElement).toBe(document.body);
    expect(menu).toHaveStyle({ position: "fixed" });
    expect(menu).toHaveAttribute("data-placement", "top");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger).toHaveAttribute("aria-controls", menu.id);
    expect(menu).toHaveTextContent("需要授权的操作由你确认");
    expect(menu).toHaveTextContent("仅限当前任务");

    await user.click(screen.getByRole("menuitemradio", { name: /^本任务免审批/ }));
    expect(screen.getByRole("alertdialog", { name: "确认本任务免审批" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("alertdialog", { name: "确认本任务免审批" })).toBeNull();
    await waitFor(() => expect(screen.getByRole("menuitemradio", { name: /^本任务免审批/ })).toHaveFocus());

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "本任务权限" })).toBeNull();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("方向键导航时跳过不可用模式，Escape 关闭并返回触发器", async () => {
    mocks.permissionModeGet.mockResolvedValue(modeStatus(undefined, { autoModeAvailable: false }));
    const user = userEvent.setup();
    render(<PermissionPicker />);
    await waitFor(() => expect(usePermissionModeStore.getState().capabilityStatus?.autoModeAvailable).toBe(false));
    const trigger = screen.getByRole("button", { name: "请求批准" });
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(screen.getByRole("menuitemradio", { name: /^请求批准/ })).toHaveFocus());
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitemradio", { name: /^本任务免审批/ })).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(usePermissionModeStore.getState().homeMode).toBe("ask");
  });

  it("切换任务会撤销尚未确认的提权选择", async () => {
    mocks.permissionModeGet.mockImplementation((id?: string) => Promise.resolve(modeStatus(id)));
    const user = userEvent.setup();
    const view = render(<PermissionPicker sessionId="session-1" />);
    await user.click(screen.getByRole("button", { name: "请求批准" }));
    await user.click(screen.getByRole("menuitemradio", { name: /^本任务免审批/ }));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    view.rerender(<PermissionPicker sessionId="session-2" />);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(mocks.permissionModeSet).not.toHaveBeenCalled();
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
    await user.click(screen.getByRole("button", { name: /请求批准/ }));
    await user.click(screen.getByRole("menuitemradio", { name: /^自动判断/ }));

    expect(usePermissionModeStore.getState().homeMode).toBe("auto");
    expect(usePermissionModeStore.getState().statuses.other.permissionMode)
      .toBe("always-approve");
    expect(mocks.permissionModeSet).not.toHaveBeenCalled();
    expect(onToast).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "自动判断" })).toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: /请求批准/ }));
    expect(screen.getByText("仅限当前任务")).toBeInTheDocument();
    await user.click(screen.getByRole("menuitemradio", { name: /^自动判断/ }));

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
      "仍有 1 项操作等待你确认",
    );
  });

  it("提高为本任务免审批前要求明确确认", async () => {
    useSessionsStore.setState({ independent: [session("session-1")] });
    mocks.permissionModeGet.mockResolvedValue(modeStatus("session-1"));
    mocks.permissionModeSet.mockResolvedValue(setResult("session-1", "always-approve"));
    const user = userEvent.setup();
    render(<PermissionPicker sessionId="session-1" />);

    await user.click(await screen.findByRole("button", { name: /请求批准/ }));
    await user.click(screen.getByRole("menuitemradio", { name: /^本任务免审批/ }));

    const dialog = screen.getByRole("alertdialog", { name: "确认本任务免审批" });
    expect(within(dialog).getByText(/现有请求仍需单独确认/)).toBeInTheDocument();
    expect(within(dialog).getByText(/网页与电脑操作仍遵守各自的授权规则/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "取消" })).toHaveFocus();
    expect(mocks.permissionModeSet).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "确认开启" }));
    await waitFor(() => expect(mocks.permissionModeSet)
      .toHaveBeenCalledWith("session-1", "always-approve"));
  });

  it("下一动画帧前打开确认框，菜单的延迟聚焦不会抢走取消按钮焦点", async () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
    const user = userEvent.setup();
    const view = render(<PermissionPicker />);
    try {
      const trigger = screen.getByRole("button", { name: "请求批准" });
      await user.click(trigger);
      const alwaysOption = screen.getByRole("menuitemradio", { name: /^本任务免审批/ });
      await user.click(alwaysOption);

      const dialog = screen.getByRole("alertdialog", { name: "确认本任务免审批" });
      const cancel = within(dialog).getByRole("button", { name: "取消" });
      expect(cancel).toHaveFocus();
      await act(async () => vi.advanceTimersToNextFrame());
      expect(cancel).toHaveFocus();
      expect(mocks.permissionModeSet).not.toHaveBeenCalled();
      expect(usePermissionModeStore.getState().homeMode).toBe("ask");

      await user.keyboard("{Escape}");
      await act(async () => vi.advanceTimersToNextFrame());
      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(alwaysOption).toHaveFocus();

      await user.keyboard("{Escape}");
      await act(async () => vi.advanceTimersToNextFrame());
      expect(screen.queryByRole("menu")).toBeNull();
      expect(trigger).toHaveFocus();
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it("电脑模式的边界在确认时说明，切换成功后不重复弹提示", async () => {
    useSessionsStore.setState({ independent: [session("session-1")] });
    mocks.permissionModeGet.mockResolvedValue(modeStatus("session-1"));
    mocks.permissionModeSet.mockResolvedValue(setResult("session-1", "always-approve"));
    const { useSessionStore } = await import("@/stores/session-store");
    useSessionStore.setState((state) => ({
      ...state,
      transcripts: {
        ...state.transcripts,
        "session-1": {
          ...state.transcripts["session-1"],
          agentMode: "computer_use",
          messages: [],
          streamingMessageId: null,
          pendingSendNowPromptId: null,
          usage: {},
          plan: null,
          planMode: false,
          planApprovals: [],
          suppressReplay: false,
          dismissedControlPromptIds: [],
        },
      },
    }));
    const onToast = vi.fn();
    const user = userEvent.setup();
    render(<PermissionPicker sessionId="session-1" onToast={onToast} />);

    await user.click(await screen.findByRole("button", { name: /请求批准/ }));
    await user.click(screen.getByRole("menuitemradio", { name: /^本任务免审批/ }));
    await user.click(screen.getByRole("button", { name: "确认开启" }));

    await waitFor(() => expect(mocks.permissionModeSet).toHaveBeenCalledWith("session-1", "always-approve"));
    expect(onToast).not.toHaveBeenCalled();
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
    await user.click(screen.getByRole("button", { name: /请求批准/ }));

    expect(screen.getByText("权限模式已被组织策略锁定为 ask")).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: /^自动判断/ })).toBeDisabled();
    expect(mocks.permissionModeSet).not.toHaveBeenCalled();
  });

  it("任务尚未加载进 Runtime 时展示状态并禁止权限切换", async () => {
    useSessionsStore.setState({ independent: [session("session-1")] });
    mocks.permissionModeGet.mockResolvedValue(modeStatus("session-1", {
      runtimeSyncState: "offline",
      runtimeAppliedMode: undefined,
    }));
    const user = userEvent.setup();
    render(<PermissionPicker sessionId="session-1" />);

    await waitFor(() => expect(usePermissionModeStore.getState().statuses["session-1"])
      .toBeDefined());
    await user.click(screen.getByRole("button", { name: /请求批准/ }));

    expect(screen.getByRole("status")).toHaveTextContent(
      "当前任务正在加载，权限模式暂不可切换",
    );
    expect(screen.getByRole("menuitemradio", { name: /^自动判断/ })).toBeDisabled();
    expect(mocks.permissionModeSet).not.toHaveBeenCalled();
  });

  it("能力变化会将首页不再可用的草稿权限安全回退为请求批准", async () => {
    usePermissionModeStore.setState({ homeMode: "auto" });
    mocks.permissionModeGet.mockResolvedValue(modeStatus(undefined, {
      autoModeAvailable: false,
      autoModeUnavailableReason: "自动判断已被组织策略关闭",
    }));
    render(<PermissionPicker />);

    await waitFor(() => expect(usePermissionModeStore.getState().homeMode).toBe("ask"));
    expect(screen.getByRole("button", { name: /请求批准/ })).toBeInTheDocument();
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

    await user.click(screen.getByRole("button", { name: /请求批准/ }));
    await user.click(screen.getByRole("menuitemradio", { name: /^自动判断/ }));
    await waitFor(() => expect(usePermissionModeStore.getState().statuses["session-1"]?.permissionMode)
      .toBe("auto"));

    await act(async () => resolveInitialRead?.(modeStatus("session-1")));
    expect(usePermissionModeStore.getState().statuses["session-1"].permissionMode).toBe("auto");
  });

  it("后端拒绝切换时保留原权限并给出可理解的错误", async () => {
    useSessionsStore.setState({ independent: [session("session-1")] });
    mocks.permissionModeGet.mockResolvedValue(modeStatus("session-1"));
    mocks.permissionModeSet.mockRejectedValue(new Error("自动判断已被组织策略关闭"));
    const onToast = vi.fn();
    const user = userEvent.setup();
    render(<PermissionPicker sessionId="session-1" onToast={onToast} />);

    await waitFor(() => expect(usePermissionModeStore.getState().statuses["session-1"])
      .toBeDefined());
    await user.click(screen.getByRole("button", { name: /请求批准/ }));
    await user.click(screen.getByRole("menuitemradio", { name: /^自动判断/ }));

    await waitFor(() => expect(onToast)
      .toHaveBeenCalledWith("权限模式切换失败：自动判断已被组织策略关闭"));
    expect(useSessionsStore.getState().independent[0].permissionMode).toBe("ask");
    expect(usePermissionModeStore.getState().statuses["session-1"].permissionMode).toBe("ask");
  });
});
