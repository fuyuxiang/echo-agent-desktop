import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolvePermission } = vi.hoisted(() => ({
  resolvePermission: vi.fn(),
}));

vi.mock("@/lib/agent-client", () => ({
  agentResolvePermission: resolvePermission,
}));

import { PermissionInlineCard } from "../PermissionDialog";
import { usePermissionStore } from "@/stores/permission-store";
import type { PermissionRequest } from "@/lib/types";

const request: PermissionRequest = {
  requestId: "permission-1",
  sessionId: "session-1",
  toolCallId: "tool-1",
  toolKind: "execute",
  title: "Execute `python3` with a very long command that must not widen the panel",
  rawInput: { command: "python3 -c 'print(1)'" },
  options: [
    { optionId: "deny", kind: "deny", title: "No" },
    { optionId: "always-all", kind: "allow_always", title: "Yes, and don't ask again for anything (always-approve mode)" },
    { optionId: "always-python", kind: "allow_always", title: "Always allow: python3" },
    { optionId: "once", kind: "allow", title: "Yes, proceed" },
  ],
};

describe("PermissionInlineCard", () => {
  beforeEach(() => {
    resolvePermission.mockReset().mockResolvedValue(true);
    usePermissionStore.setState({ queues: {}, closedRequestIds: [] });
    usePermissionStore.getState().request(request);
  });

  it("把动态英文选项整理为窄栏可读的分层中文操作", () => {
    render(<PermissionInlineCard sessionId="session-1" />);

    expect(screen.getByText("执行命令")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "拒绝" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "允许本次" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /本任务全部始终允许/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /始终允许 python3/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消请求" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Yes, and don't ask again/ })).toBeNull();

    const details = screen.getByText("查看完整操作参数").closest("details");
    expect(details).not.toHaveAttribute("open");
  });

  it("仍按原 optionId 精确提交授权并在后端确认后关闭卡片", async () => {
    render(<PermissionInlineCard sessionId="session-1" />);

    fireEvent.click(screen.getByRole("button", { name: "允许本次" }));
    expect(resolvePermission).toHaveBeenCalledWith("permission-1", {
      optionId: "once",
      cancelled: false,
    });
    await waitFor(() => expect(screen.queryByRole("region", { name: "操作授权" })).toBeNull());
  });

  it("保留未来运行时的未知选项，不会静默丢失用户可选项", () => {
    usePermissionStore.setState({ queues: {}, closedRequestIds: [] });
    usePermissionStore.getState().request({
      ...request,
      options: [{ optionId: "runtime-choice", kind: "other", title: "Runtime choice" }],
    });

    render(<PermissionInlineCard sessionId="session-1" />);
    const group = screen.getByRole("group", { name: "其他选项" });
    expect(within(group).getByRole("button", { name: "Runtime choice" })).toBeInTheDocument();
  });
});
