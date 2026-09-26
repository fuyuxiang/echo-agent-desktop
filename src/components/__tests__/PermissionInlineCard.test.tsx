import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolvePermission, setPermissionMode } = vi.hoisted(() => ({
  resolvePermission: vi.fn(),
  setPermissionMode: vi.fn(),
}));

vi.mock("@/lib/agent-client", () => ({
  agentResolvePermission: resolvePermission,
  permissionModeSet: setPermissionMode,
}));

import { PermissionInlineCard } from "../PermissionDialog";
import { usePermissionStore } from "@/stores/permission-store";
import { usePermissionModeStore } from "@/stores/permission-mode-store";
import { useSessionsStore } from "@/stores/sessions-store";
import type { PermissionRequest } from "@/lib/types";

const request: PermissionRequest = {
  requestId: "permission-1",
  sessionId: "session-1",
  toolCallId: "tool-1",
  toolKind: "execute",
  title: "Execute `python3` with a very long command that must not widen the panel",
  rawInput: { command: "python3 -c 'print(1)'" },
  options: [
    {
      optionId: "enable-always-approve",
      kind: "allow",
      title: "Yes, and don't ask again for anything (always-approve mode)",
    },
    { optionId: "allow-once", kind: "allow", title: "Yes, proceed" },
    { optionId: "reject-once", kind: "deny", title: "No, and tell EchoAgent what to do differently" },
    { optionId: "reject-always-command", kind: "deny_always", title: "Always reject: rm" },
  ],
};

describe("PermissionInlineCard", () => {
  beforeEach(() => {
    resolvePermission.mockReset().mockResolvedValue(true);
    setPermissionMode.mockReset().mockResolvedValue({
      sessionId: "session-1",
      permissionMode: "always-approve",
      configuredPermissionMode: "always-approve",
      autoModeAvailable: true,
      alwaysApproveAvailable: true,
      locked: false,
      runtimeSyncState: "synced",
      runtimeAppliedMode: "always-approve",
      agentRunning: true,
      runtimeSynced: true,
      resolvedPending: 0,
      remainingPending: 1,
      resolvedPermissions: [],
    });
    usePermissionStore.setState({ queues: {}, closedRequestIds: [], priorityRequestBySession: {} });
    usePermissionModeStore.setState({ homeMode: "ask", statuses: {}, capabilityStatus: null });
    useSessionsStore.setState({
      independent: [{
        sessionId: "session-1",
        title: "Task",
        cwd: "/workspace",
        status: "awaiting_permission",
        permissionMode: "ask",
      }],
      pendingSessionPatches: {},
    });
    usePermissionStore.getState().request(request);
  });

  it("将运行时特殊选项整理为三个不重复的主操作", () => {
    render(<PermissionInlineCard sessionId="session-1" />);

    expect(screen.getByText("执行命令")).toBeInTheDocument();
    const choices = screen.getByRole("group", { name: "授权选择" });
    expect(within(choices).getAllByRole("button")).toHaveLength(3);
    expect(within(choices).getByRole("button", { name: "允许本次" })).toBeInTheDocument();
    const alwaysButton = within(choices).getByRole("button", { name: /本任务始终允许/ });
    expect(alwaysButton).toBeInTheDocument();
    expect(alwaysButton.getAttribute("title")).toMatch(/操作电脑仍逐次确认/);
    expect(within(choices).getByRole("button", { name: "拒绝" })).toBeInTheDocument();
    expect(screen.getAllByText("允许本次")).toHaveLength(1);
    expect(screen.getByText("更多授权选项")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "取消请求" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Yes, and don't ask again/ })).toBeNull();

    const details = screen.getByText("查看完整操作参数").closest("details");
    expect(details).not.toHaveAttribute("open");
  });

  it("点击授权通知后将对应请求置顶并聚焦", async () => {
    usePermissionStore.getState().request({ ...request, requestId: "permission-2", toolCallId: "tool-2" });
    render(<PermissionInlineCard sessionId="session-1" />);
    act(() => usePermissionStore.getState().promote("permission-2", "session-1"));
    const card = screen.getByRole("region", { name: "操作授权" });
    expect(card).toHaveAttribute("id", "permission-permission-2");
    await waitFor(() => expect(card).toHaveFocus());
    expect(usePermissionStore.getState().priorityRequestBySession["session-1"]).toBeUndefined();
  });

  it("仍按原 optionId 精确提交授权并在后端确认后关闭卡片", async () => {
    render(<PermissionInlineCard sessionId="session-1" />);

    fireEvent.click(screen.getByRole("button", { name: "允许本次" }));
    expect(resolvePermission).toHaveBeenCalledWith("permission-1", {
      optionId: "allow-once",
      cancelled: false,
    });
    await waitFor(() => expect(screen.queryByRole("region", { name: "操作授权" })).toBeNull());
  });

  it("本任务始终允许要求二次确认并完整执行模式切换与当前授权", async () => {
    render(<PermissionInlineCard sessionId="session-1" />);

    fireEvent.click(screen.getByRole("button", { name: /本任务始终允许/ }));
    const dialog = screen.getByRole("alertdialog", { name: "确认本任务始终允许" });
    expect(within(dialog).getByText(/后续的命令、文件修改等操作不再询问/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "取消" })).toHaveFocus();
    expect(setPermissionMode).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "确认并允许当前操作" }));

    await waitFor(() => expect(setPermissionMode)
      .toHaveBeenCalledWith("session-1", "always-approve"));
    await waitFor(() => expect(resolvePermission).toHaveBeenCalledWith("permission-1", {
      optionId: "enable-always-approve",
      cancelled: false,
    }));
    expect(setPermissionMode.mock.invocationCallOrder[0])
      .toBeLessThan(resolvePermission.mock.invocationCallOrder[0]);
    expect(usePermissionModeStore.getState().statuses["session-1"]?.permissionMode)
      .toBe("always-approve");
    expect(useSessionsStore.getState().independent.find((entry) => entry.sessionId === "session-1")?.permissionMode)
      .toBe("always-approve");
    await waitFor(() => expect(screen.queryByRole("region", { name: "操作授权" })).toBeNull());
  });

  it("模式切换失败时保留请求并展示可操作的错误", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    setPermissionMode.mockRejectedValue(new Error("权限模式已被组织策略锁定"));
    render(<PermissionInlineCard sessionId="session-1" />);

    fireEvent.click(screen.getByRole("button", { name: /本任务始终允许/ }));
    fireEvent.click(screen.getByRole("button", { name: "确认并允许当前操作" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "无法切换为“本任务始终允许”：权限模式已被组织策略锁定",
    );
    expect(resolvePermission).not.toHaveBeenCalled();
    expect(screen.getByRole("region", { name: "操作授权" })).toBeInTheDocument();
    consoleError.mockRestore();
  });

  it("有精确范围授权时优先提供，任务级全授权收入更多选项", () => {
    usePermissionStore.setState({ queues: {}, closedRequestIds: [] });
    usePermissionStore.getState().request({
      ...request,
      options: [
        ...request.options,
        { optionId: "allow-always-command", kind: "allow_always", title: "Always allow: python3" },
      ],
    });

    render(<PermissionInlineCard sessionId="session-1" />);
    const choices = screen.getByRole("group", { name: "授权选择" });
    expect(within(choices).getByRole("button", { name: /始终允许 python3/ })).toBeInTheDocument();
    expect(within(choices).queryByRole("button", { name: /本任务始终允许/ })).toBeNull();

    fireEvent.click(screen.getByText("更多授权选项"));
    expect(screen.getByRole("button", { name: /本任务始终允许/ })).toBeInTheDocument();
  });

  it("保留未来运行时的未知选项，不会静默丢失用户可选项", () => {
    usePermissionStore.setState({ queues: {}, closedRequestIds: [] });
    usePermissionStore.getState().request({
      ...request,
      options: [{ optionId: "runtime-choice", kind: "other", title: "Runtime choice" }],
    });

    render(<PermissionInlineCard sessionId="session-1" />);
    fireEvent.click(screen.getByText("更多授权选项"));
    const group = screen.getByRole("group", { name: "更多授权选项" });
    expect(within(group).getByRole("button", { name: "Runtime choice" })).toBeInTheDocument();
  });
});
