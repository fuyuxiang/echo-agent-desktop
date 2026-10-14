import { expect, it } from "vitest";
import { reconcileSessionCatalog } from "../session-catalog";
import type { SessionSummary } from "../types";

const row = (sessionId: string, title: string): SessionSummary => ({ sessionId, title, cwd: "/workspace" });
it("在途快照不吞掉新会话、不复活删除、不回退标题和终态", () => {
  const before = [row("edit", "旧标题"), row("delete", "删除项")];
  const current = [{ ...row("edit", "新标题"), status: "completed" as const }, row("new", "新增项")];
  const snapshot = [{ ...row("edit", "旧标题"), status: "working" as const, currentModelId: "model" }, row("delete", "删除项"), row("external", "远程新增")];
  expect(reconcileSessionCatalog(snapshot, before, current)).toEqual([
    row("new", "新增项"),
    { ...row("edit", "新标题"), status: "completed", currentModelId: "model" },
    row("external", "远程新增"),
  ]);
});
it("未发生本地编辑时采用后端新增、修改与删除", () => {
  const before = [row("edit", "旧标题"), row("delete", "删除项")];
  const snapshot = [row("edit", "后端标题"), row("external", "外部项")];
  expect(reconcileSessionCatalog(snapshot, before, before)).toEqual(snapshot);
});
