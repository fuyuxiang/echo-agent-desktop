import { beforeEach, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { groupCleanupAck, groupCleanupPending } from "../group-client";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("../group-client", async original => ({...await original<typeof import("../group-client")>(),groupCleanupPending:vi.fn(),groupCleanupAck:vi.fn(async()=>{})}));
beforeEach(()=>{localStorage.clear();vi.clearAllMocks();});

it("写入失败不确认清理，重启后从原生记录继续，成功后才确认", async () => {
  const id="restart-cleanup";
  vi.mocked(groupCleanupPending).mockResolvedValue([{groupId:id,sessionIds:["retired-session"]}]);
  let {useGroupStore}=await import("../group-store");
  useGroupStore.getState().setDraft(id,"必须删除的草稿");
  const original=Storage.prototype.setItem;
  const failing=vi.spyOn(Storage.prototype,"setItem").mockImplementation(function(this: Storage,key,value){if(key==="echoagent.group-drafts.v1")throw new DOMException("storage blocked","QuotaExceededError");return original.call(this,key,value);});
  expect(useGroupStore.getState().forget(id,["retired-session"])).toBe(false);
  expect(groupCleanupAck).not.toHaveBeenCalled();
  expect(useGroupStore.getState().cleanupError).toContain("重启也会继续");
  failing.mockRestore();
  expect(JSON.parse(localStorage.getItem("echoagent.group-drafts.v1")!).data[id]).toBe("必须删除的草稿");
  vi.resetModules();
  ({useGroupStore}=await import("../group-store"));
  await useGroupStore.getState().retryCleanup();
  await waitFor(()=>expect(groupCleanupAck).toHaveBeenCalledWith(id));
  expect(JSON.parse(localStorage.getItem("echoagent.group-drafts.v1")!).data[id]).toBeUndefined();
  expect(useGroupStore.getState().cleanupError).toBeNull();
});
