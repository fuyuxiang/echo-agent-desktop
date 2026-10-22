import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { recordUsage, saveQuotaConfig } from "@/lib/usage-quota";
import { groupSend } from "../group-client";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const message = { id: "request", text: "一起分析", memberIds: [], discussion: true, attachments: [], replyTo: null };
beforeEach(() => { localStorage.clear(); vi.resetAllMocks(); });
it("群消息沿用桌面端的手动发送配额，超限时不触发原生执行", async () => {
  saveQuotaConfig({ period: "daily", tokenLimit: 10, enforcement: "block" });
  recordUsage([], { modelId: "local/mock", promptTokens: 12, completionTokens: 2 });
  await expect(groupSend("group", message)).rejects.toThrow("Token 配额");
  expect(invoke).not.toHaveBeenCalled();
});
it("配额为提醒模式时，仍向现有群聊后端发送完整消息", async () => {
  saveQuotaConfig({ period: "daily", tokenLimit: 10, enforcement: "warn" });
  recordUsage([], { modelId: "local/mock", promptTokens: 12, completionTokens: 2 });
  await groupSend("group", message);
  expect(invoke).toHaveBeenCalledWith("group_send", { groupId: "group", input: message });
});
it("配额耗尽后仍可用自然消息停止协作", async () => {
  saveQuotaConfig({ period: "daily", tokenLimit: 10, enforcement: "block" });
  recordUsage([], { modelId: "local/mock", promptTokens: 12, completionTokens: 2 });
  const stop = { ...message, text: "停止当前任务！" };
  await groupSend("group", stop);
  expect(invoke).toHaveBeenCalledWith("group_send", { groupId: "group", input: stop });
});
