import { beforeEach, expect, it, vi } from "vitest";
import { buildDraft } from "@/components/automation/schedule-utils";
import { automationEditorDirty, confirmAutomationEditorExit, useAutomationEditorStore } from "../automation-editor-store";

beforeEach(() => useAutomationEditorStore.getState().close());
const edit = () => {
  const store = useAutomationEditorStore.getState();
  store.begin(buildDraft(undefined, "/workspace"));
  store.setDraft(draft => draft && ({ ...draft, name: "未保存的输入" }));
};
it("干净表单无需确认，脏草稿在确认前后均不提前清除", async () => {
  const confirm = vi.fn(async () => true);
  useAutomationEditorStore.getState().begin(buildDraft());
  expect(automationEditorDirty()).toBe(false);
  await confirmAutomationEditorExit(confirm); expect(confirm).not.toHaveBeenCalled();
  edit(); expect(automationEditorDirty()).toBe(true);
  await confirmAutomationEditorExit(confirm);
  expect(useAutomationEditorStore.getState().draft?.name).toBe("未保存的输入");
  await expect(confirmAutomationEditorExit(async () => false)).rejects.toThrow("退出已取消");
  expect(useAutomationEditorStore.getState().draft?.name).toBe("未保存的输入");
});
it.each(["saving", "deleting"] as const)("%s 中或确认期间变化的草稿不能静默退出", async (operation) => {
  edit(); const generation = useAutomationEditorStore.getState().generation;
  useAutomationEditorStore.getState().startOperation(operation, generation);
  const confirm = vi.fn(async () => true);
  await expect(confirmAutomationEditorExit(confirm)).rejects.toThrow(operation === "deleting" ? "正在删除" : "正在保存");
  expect(confirm).not.toHaveBeenCalled(); useAutomationEditorStore.getState().finishOperation(generation);
  await expect(confirmAutomationEditorExit(async () => {
    useAutomationEditorStore.getState().setDraft(draft => draft && ({ ...draft, name: "最新输入" })); return true;
  })).rejects.toThrow("草稿已变化");
  expect(useAutomationEditorStore.getState().draft?.name).toBe("最新输入");
});
it("迟到的保存响应不能关闭另一个编辑流程或改变其忙碌状态", () => {
  edit(); const generation = useAutomationEditorStore.getState().generation;
  useAutomationEditorStore.getState().close(); edit();
  const current = useAutomationEditorStore.getState(); current.startOperation("saving", current.generation);
  useAutomationEditorStore.getState().close(generation); useAutomationEditorStore.getState().finishOperation(generation);
  expect(useAutomationEditorStore.getState().draft?.name).toBe("未保存的输入");
  expect(useAutomationEditorStore.getState().operation).toBe("saving");
});

it("同一编辑流程只接受一个写操作，迟到响应不能标记另一份草稿为已保存", () => {
  edit(); const original = useAutomationEditorStore.getState();
  expect(original.startOperation("saving", original.generation)).toBe(true);
  expect(original.startOperation("deleting", original.generation)).toBe(false);
  const saved = { ...original.draft!, id: "saved", createdAt: "2026-10-17" };
  original.close(); edit();
  useAutomationEditorStore.getState().markSaved(saved, original.draft!, original.generation);
  expect(useAutomationEditorStore.getState().isCreating).toBe(true);
  expect(automationEditorDirty()).toBe(true);
});

it("保存返回服务端规范化的基线，同时保留请求发出后的新输入", () => {
  edit(); const original = useAutomationEditorStore.getState();
  const saved = { ...original.draft!, id: "saved", name: "已保存", createdAt: "2026-10-17" };
  original.markSaved(saved, original.draft!, original.generation);
  expect(useAutomationEditorStore.getState().draft?.name).toBe("已保存");
  expect(automationEditorDirty()).toBe(false);
  const submitted = useAutomationEditorStore.getState().draft!;
  original.setDraft({ ...submitted, name: "更晚的输入" });
  original.markSaved(saved, submitted, original.generation);
  expect(useAutomationEditorStore.getState().draft?.name).toBe("更晚的输入");
  expect(automationEditorDirty()).toBe(true);
});
