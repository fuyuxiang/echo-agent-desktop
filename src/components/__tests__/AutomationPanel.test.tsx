import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { AutomationPanel } from "../AutomationPanel";
import { AutomationPermissionConfirmDialog } from "../automation/AutomationPermissionConfirmDialog";
import type { AutomationSnapshot } from "@/lib/types";

// ---- mock Tauri IPC 层 ----
const emptySnapshot: AutomationSnapshot = { automations: [], records: [] };
let snapshot: AutomationSnapshot = emptySnapshot;

vi.mock("@/lib/agent-client", () => ({
  automationsSnapshot: vi.fn(async () => snapshot),
  automationsSave: vi.fn(async (a: unknown) => a),
  automationsDelete: vi.fn(async () => {}),
  automationsSetStatus: vi.fn(async () => {}),
  automationsRun: vi.fn(async () => "record-id"),
  automationRecordsArchive: vi.fn(async () => {}),
  automationRecordsDelete: vi.fn(async () => {}),
  agentListWorkspaces: vi.fn(async () => []),
  providersList: vi.fn(async () => ({ providers: [], models: [] })),
  skillsList: vi.fn(async () => []),
  agentsList: vi.fn(async () => []),
  mcpList: vi.fn(async () => []),
  flattenModels: vi.fn((catalog: { models?: unknown[] }) => catalog.models ?? []),
}));

import {
  agentListWorkspaces,
  agentsList,
  automationsSnapshot,
  mcpList,
  providersList,
  skillsList,
} from "@/lib/agent-client";

beforeEach(() => {
  snapshot = emptySnapshot;
  vi.mocked(automationsSnapshot).mockReset().mockImplementation(async () => snapshot);
  vi.mocked(agentListWorkspaces).mockReset().mockResolvedValue([]);
  vi.mocked(providersList).mockReset().mockResolvedValue({ providers: [], models: [] });
  vi.mocked(skillsList).mockReset().mockResolvedValue([]);
  vi.mocked(agentsList).mockReset().mockResolvedValue([]);
  vi.mocked(mcpList).mockReset().mockResolvedValue([]);
});

describe("AutomationPanel（截图 1/3 空态）", () => {
  it("渲染 定时任务/运行记录 页签", async () => {
    render(<AutomationPanel />);
    expect(screen.getByText("定时任务")).toBeInTheDocument();
    expect(screen.getByText("运行记录")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("开启你的第一个自动化任务吧")).toBeInTheDocument());
  });

  it("定时任务空态：hero 文案 + 添加按钮 + 12 个模板", async () => {
    render(<AutomationPanel />);
    await waitFor(() => expect(screen.getByText("开启你的第一个自动化任务吧")).toBeInTheDocument());
    expect(screen.getByText("+ 添加自动化")).toBeInTheDocument();
    expect(screen.getByText("自动化任务模版")).toBeInTheDocument();
    expect(screen.getByText("每日 AI 新闻推送")).toBeInTheDocument();
    expect(screen.getByText("可爱萌宠手机壁纸")).toBeInTheDocument();
  });

  it("运行记录空态：暂无运行记录", async () => {
    render(<AutomationPanel />);
    fireEvent.click(screen.getByText("运行记录"));
    await waitFor(() => expect(screen.getByText("暂无运行记录")).toBeInTheDocument());
  });

  it("首次加载失败显示持久错误和重试，不伪装成空列表", async () => {
    vi.mocked(automationsSnapshot).mockRejectedValueOnce(new Error("快照损坏"));
    render(<AutomationPanel />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("自动化数据加载失败：快照损坏");
    expect(screen.queryByText("开启你的第一个自动化任务吧")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("开启你的第一个自动化任务吧")).toBeInTheDocument();
  });

  it("点击「+ 添加自动化」进入表单（截图 2 字段）", async () => {
    render(<AutomationPanel />);
    await waitFor(() => screen.getByText("+ 添加自动化"));
    fireEvent.click(screen.getByText("+ 添加自动化"));
    await waitFor(() => expect(screen.getByText("添加自动化任务")).toBeInTheDocument());
    expect(screen.getByText("名称")).toBeInTheDocument();
    expect(screen.getByText("工作空间", { selector: "label" })).toBeInTheDocument();
    expect(screen.getByText("提示词")).toBeInTheDocument();
    expect(screen.getByText("执行频率")).toBeInTheDocument();
    expect(screen.getByText("周期")).toBeInTheDocument();
    expect(screen.getByText("按间隔")).toBeInTheDocument();
    expect(screen.getByText("单次")).toBeInTheDocument();
    expect(screen.getByText(/生效日期区间/)).toBeInTheDocument();
    expect(screen.getByText(/完成后推送到通知渠道/)).toBeInTheDocument();
    expect(screen.getByText("取消")).toBeInTheDocument();
    expect(screen.getByText("保存")).toBeInTheDocument();
    // 提示词工具条 chips
    expect(screen.getByText("Auto")).toBeInTheDocument();
    expect(screen.getByText(/技能/)).toBeInTheDocument();
    expect(screen.getByText("召唤专家")).toBeInTheDocument();
    expect(screen.getByText("默认权限")).toBeInTheDocument();
  });

  it("引用目录分项失败时保留成功数据并可重试，不伪装空状态", async () => {
    vi.mocked(providersList).mockRejectedValueOnce(new Error("模型目录离线"));
    vi.mocked(skillsList).mockResolvedValueOnce([
      { name: "review", displayName: "代码审查", enabled: true },
    ]);
    render(<AutomationPanel />);
    fireEvent.click(await screen.findByText("+ 添加自动化"));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("模型：模型目录离线");
    expect(alert).toHaveTextContent("已保留其他可用数据");
    fireEvent.click(screen.getByRole("button", { name: /^技能/ }));
    expect(screen.getByRole("button", { name: "代码审查" })).toBeInTheDocument();

    fireEvent.click(within(alert).getByRole("button", { name: "重试" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("点击模板卡片预填进入创建表单", async () => {
    render(<AutomationPanel />);
    await waitFor(() => screen.getByText("每日 AI 新闻推送"));
    fireEvent.click(screen.getByText("每日 AI 新闻推送"));
    await waitFor(() => {
      const nameInput = document.querySelector(".atm-modal-input") as HTMLInputElement;
      expect(nameInput?.value).toBe("每日 AI 新闻推送");
    });
  });

  it("频率切换：按间隔显示 每 N 小时，单次显示日期选择", async () => {
    render(<AutomationPanel />);
    await waitFor(() => screen.getByText("+ 添加自动化"));
    fireEvent.click(screen.getByText("+ 添加自动化"));
    await waitFor(() => screen.getByText("执行频率"));
    fireEvent.click(screen.getByText("按间隔"));
    expect(screen.getByText("每")).toBeInTheDocument();
    expect(screen.getByText("小时")).toBeInTheDocument();
    fireEvent.click(screen.getByText("单次"));
    // 单次模式下隐藏生效日期区间
    expect(screen.queryByText(/生效日期区间/)).not.toBeInTheDocument();
    // 切回周期恢复
    fireEvent.click(screen.getByText("周期"));
    expect(screen.getByText(/生效日期区间/)).toBeInTheDocument();
  });
});

describe("AutomationPermissionConfirmDialog 可访问性", () => {
  it("默认聚焦安全操作，支持 Tab 圈定、Escape 和焦点恢复", async () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const onFallback = vi.fn();
    const view = (open: boolean) => (
      <>
        <button type="button">打开权限确认</button>
        <AutomationPermissionConfirmDialog
          open={open}
          onConfirm={onConfirm}
          onCancel={onCancel}
          onFallbackToDefault={onFallback}
        />
      </>
    );
    const { rerender } = render(view(false));
    const invoker = screen.getByRole("button", { name: "打开权限确认" });
    invoker.focus();

    rerender(view(true));
    const dialog = screen.getByRole("alertdialog", { name: /完全访问权限运行/ });
    const cancel = within(dialog).getByRole("button", { name: "取消" });
    expect(cancel).toHaveFocus();

    const acknowledgement = within(dialog).getByRole("checkbox", { name: /我已了解风险/ });
    fireEvent.click(acknowledgement);
    const confirm = within(dialog).getByRole("button", { name: "确认创建" });
    await waitFor(() => expect(confirm).toBeEnabled());
    confirm.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(acknowledgement).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    rerender(view(false));
    expect(invoker).toHaveFocus();
  });
});

describe("AutomationPanel（有任务/有记录）", () => {
  const baseAutomation = {
    id: "a1",
    name: "每日 AI 新闻推送",
    prompt: "整理 AI 新闻",
    cwds: "",
    status: "ACTIVE" as const,
    skills: [],
    connectorIds: [],
    permissionMode: "fullAccess" as const,
    scheduleType: "recurring" as const,
    schedule: {
      freq: "DAILY" as const,
      interval: 1,
      byday: ["MO", "TU", "WE", "TH", "FR", "SA", "SU"],
      bymonthday: [],
      bymonth: [],
      byhour: 9,
      byminute: 0,
      intervalHours: 1,
    },
    pushToWeChat: false,
    createdAt: new Date().toISOString(),
  };

  it("危险操作确认弹窗默认聚焦取消、圈定 Tab 并在 Escape 后恢复触发器", async () => {
    snapshot = { automations: [baseAutomation], records: [] };
    render(<AutomationPanel />);

    const trigger = await screen.findByRole("button", { name: `打开「${baseAutomation.name}」更多操作` });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "删除" }));

    const dialog = screen.getByRole("dialog", { name: `删除 ${baseAutomation.name}？` });
    const cancel = within(dialog).getByRole("button", { name: "取消" });
    const remove = within(dialog).getByRole("button", { name: "删除自动化任务" });
    expect(cancel).toHaveFocus();

    remove.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(cancel).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: `删除 ${baseAutomation.name}？` })).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("任务列表：显示名称与调度摘要", async () => {
    snapshot = { automations: [baseAutomation], records: [] };
    render(<AutomationPanel />);
    await waitFor(() => expect(screen.getByText("每日 AI 新闻推送")).toBeInTheDocument());
    expect(screen.getByText("当前")).toBeInTheDocument();
    expect(screen.getByText("每天 09:00")).toBeInTheDocument();
    // 有任务时工具栏出现搜索/批量管理/添加自动化
    expect(screen.getByPlaceholderText("搜索自动化/记录")).toBeInTheDocument();
    expect(screen.getByText("批量管理")).toBeInTheDocument();
    expect(screen.getByText("添加自动化")).toBeInTheDocument();
  });

  it("运行记录：按天分组显示", async () => {
    snapshot = {
      automations: [baseAutomation],
      records: [
        {
          id: "r1",
          automationId: "a1",
          automationName: "每日 AI 新闻推送",
          status: "success",
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          archived: false,
        },
      ],
    };
    render(<AutomationPanel />);
    fireEvent.click(screen.getByText("运行记录"));
    await waitFor(() => expect(screen.getByText("今天")).toBeInTheDocument());
    expect(screen.getByText("每日 AI 新闻推送")).toBeInTheDocument();
    expect(screen.getByText("成功")).toBeInTheDocument();
  });

  it("运行记录：点击可打开对应 Agent 会话", async () => {
    const onOpenSession = vi.fn();
    snapshot = {
      automations: [baseAutomation],
      records: [
        {
          id: "r-session",
          automationId: "a1",
          automationName: "可查看结果的任务",
          status: "success",
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          sessionId: "session-123",
          cwd: "/workspace/project",
          archived: false,
        },
      ],
    };
    render(<AutomationPanel onOpenSession={onOpenSession} />);
    fireEvent.click(screen.getByText("运行记录"));
    const row = await screen.findByRole("button", { name: /可查看结果的任务/ });
    fireEvent.click(row);
    expect(onOpenSession).toHaveBeenCalledWith("session-123", "/workspace/project");
  });

  it("排队中的任务展示真实状态并防止重复运行或删除记录", async () => {
    snapshot = {
      automations: [baseAutomation],
      records: [
        {
          id: "r-queued",
          automationId: "a1",
          automationName: "正在排队的任务",
          status: "queued",
          startedAt: new Date().toISOString(),
          archived: false,
        },
      ],
    };
    render(<AutomationPanel />);

    const runButton = await screen.findByLabelText("「每日 AI 新闻推送」正在运行");
    expect(runButton).toBeDisabled();

    fireEvent.click(screen.getByText("运行记录"));
    expect(await screen.findByText("等待调度")).toBeInTheDocument();
    expect(screen.queryByTitle("归档")).not.toBeInTheDocument();
    expect(screen.queryByTitle("删除")).not.toBeInTheDocument();
  });

  it("忽略晚到的旧快照响应", async () => {
    let resolveOld!: (value: AutomationSnapshot) => void;
    const oldRequest = new Promise<AutomationSnapshot>((resolve) => { resolveOld = resolve; });
    const freshSnapshot: AutomationSnapshot = {
      automations: [{ ...baseAutomation, id: "fresh", name: "新快照任务" }],
      records: [],
    };
    vi.mocked(automationsSnapshot)
      .mockImplementationOnce(() => oldRequest)
      .mockResolvedValueOnce(freshSnapshot);

    const { rerender } = render(<AutomationPanel onToast={() => {}} />);
    rerender(<AutomationPanel onToast={() => undefined} />);
    expect(await screen.findByText("新快照任务")).toBeInTheDocument();

    await act(async () => {
      resolveOld({
        automations: [{ ...baseAutomation, id: "old", name: "旧快照任务" }],
        records: [],
      });
      await oldRequest;
    });
    expect(screen.queryByText("旧快照任务")).not.toBeInTheDocument();
    expect(screen.getByText("新快照任务")).toBeInTheDocument();
  });
});
