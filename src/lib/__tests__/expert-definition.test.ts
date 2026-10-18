import { beforeEach, describe, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => native);
import { mergeExpertDefinition } from "../expert-definition";
import { usePendingExpertStore } from "@/stores/pending-expert-store";

describe("expert identity/editor contract", () => {
  beforeEach(() => { native.invoke.mockReset(); });
  it("delegates YAML merging to the native parser before returning a saveable definition", async () => {
    const original = '---\n"name": Old\nmodel: custom\n---   \nold';
    const generated = '---\nname: New\n---\nnew';
    native.invoke.mockResolvedValue("validated merged definition");
    await expect(mergeExpertDefinition(original, generated)).resolves.toBe("validated merged definition");
    expect(native.invoke).toHaveBeenCalledWith("agents_merge_definition", { originalRaw: original, generatedRaw: generated });
  });
  it("propagates a malformed original without falling back to a destructive template", async () => {
    const failure = new Error("原配置未修改");
    native.invoke.mockRejectedValue(failure);
    await expect(mergeExpertDefinition("broken", "template")).rejects.toBe(failure);
  });
  it.each(["user", "project", "local"])("canonicalizes %s shortcut source to the native local binding contract", source => {
    usePendingExpertStore.getState().set({name:"Expert",expertId:"Expert",prompt:"body",description:"desc",source});
    expect(usePendingExpertStore.getState().expert?.source).toBe("local");
  });
});
