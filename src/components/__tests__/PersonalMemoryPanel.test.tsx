// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import type { PersonalMemoryRecord } from "@/lib/agent-client";

const api = vi.hoisted(() => ({ memoryRecordsGet: vi.fn(), memoryRecordSave: vi.fn(), memoryRecordRetire: vi.fn(), memoryFlush: vi.fn() }));
vi.mock("@/lib/agent-client", () => api);
vi.mock("../ResourcesPanel", () => ({ ResourcesPanel: () => <div>原有记忆文档</div> }));
vi.mock("../SettingsSections", () => ({ MemorySettingsPanel: () => <div>对话记忆开关</div> }));
import { PersonalMemoryPanel } from "../PersonalMemoryPanel";

const record: PersonalMemoryRecord = { id: "r1", scope: "global", kind: "user", key: "报告语言", content: "报告使用中文", status: "active", pinned: true, origin: "manual", confidence: 1, sources: ["source-1"], evidence: "请用中文", createdAt: 1, updatedAt: 2, validUntil: null, revision: 3 };
let saved: PersonalMemoryRecord[];
beforeEach(() => {
  vi.clearAllMocks(); saved = [{ ...record }];
  api.memoryRecordsGet.mockImplementation(async () => ({ records: saved, enabled: true, pendingCount: 0, extraction: { outcome: "saved", detail: "", succeededAt: 2 }, retrieval: { at: 0, sources: [] } }));
  api.memoryRecordSave.mockImplementation(async (input) => { const value = { ...record, ...input, revision: 4 }; saved = [value]; return value; });
  api.memoryRecordRetire.mockImplementation(async () => { saved = saved.map((v) => ({ ...v, status: "forgotten" as const })); });
});

describe("个人记忆管理", () => {
  it("默认只呈现记忆内容，排查和旧文档按需展开", async () => {
    render(<PersonalMemoryPanel cwd="/project-a" />);
    expect(await screen.findByText("报告使用中文")).toBeInTheDocument();
    expect(screen.queryByText("原有记忆文档")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("高级：记忆文档与会话摘要"));
    expect(await screen.findByText("原有记忆文档")).toBeInTheDocument();
  });
  it("更正使用打开草稿时的范围和版本，切换工作区不会改写别的项目", async () => {
    const user = userEvent.setup(); const view = render(<PersonalMemoryPanel cwd="/project-a" />);
    await user.click(await screen.findByRole("button", { name: "更正 报告语言" }));
    await user.clear(screen.getByLabelText("记忆内容")); await user.type(screen.getByLabelText("记忆内容"), "报告使用双语");
    view.rerender(<PersonalMemoryPanel cwd="/project-b" />);
    await user.click(screen.getByRole("button", { name: "保存记忆" }));
    await waitFor(() => expect(api.memoryRecordSave).toHaveBeenCalledWith(expect.objectContaining({ id: "r1", expectedRevision: 3, content: "报告使用双语" }), "/project-a"));
  });
  it("忘记后条目离开有效列表，来源对话能通过专用入口打开", async () => {
    const user = userEvent.setup(); const open = vi.fn(); render(<PersonalMemoryPanel cwd="/project-a" onOpenSession={open} />);
    await user.click(await screen.findByText("来源与依据"));
    await user.click(screen.getByRole("button", { name: "打开来源对话 source-1" })); expect(open).toHaveBeenCalledWith("source-1");
    await user.click(screen.getByRole("button", { name: "忘记 报告语言" }));
    await user.click(await screen.findByRole("button", { name: "忘记" }));
    await waitFor(() => expect(api.memoryRecordRetire).toHaveBeenCalledWith(expect.objectContaining({ id: "r1", revision: 3 }), "/project-a", false));
    await waitFor(() => expect(screen.queryByText("报告使用中文")).not.toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "已停用" })); expect(screen.getByText("已忘记")).toBeInTheDocument();
  });
  it("导入必须先预览再保存，失败保留尚未导入的草稿", async () => {
    const user = userEvent.setup(); render(<PersonalMemoryPanel />);
    await user.click(await screen.findByRole("button", { name: "导入记忆" }));
    await user.type(screen.getByLabelText("待导入的记忆"), "回答先给结论\n周报用中文");
    expect(api.memoryRecordSave).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "预览导入" }));
    api.memoryRecordSave.mockResolvedValueOnce(record).mockRejectedValueOnce(new Error("磁盘空间不足"));
    await user.click(screen.getByRole("button", { name: "添加 2 条记忆" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("已导入 1 条");
    expect(screen.getByRole("button", { name: "添加 1 条记忆" })).toBeInTheDocument();
  });
});
