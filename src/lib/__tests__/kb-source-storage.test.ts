import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { addLocalKnowledgeSource, hydrateKnowledgeSources, loadKnowledgeSourceDescriptors, removeKnowledgeSource, resetKnowledgeSourceHydration } from "../kb-source-storage";
import { listKbProviders, resetKbRegistry } from "../knowledge-base";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../tauri-kb-reader", () => ({
  isTauriAvailable: () => true,
  createTauriDirectoryReader: () => ({ listDir: async () => [], readText: async () => null }),
}));

const oldSource = { id: "old", kind: "local-folder", root: "/tmp/old-source", label: "旧知识源", enabled: true };

describe("知识源原生持久化与迁移边界", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    localStorage.clear();
    resetKbRegistry();
    resetKnowledgeSourceHydration();
    localStorage.setItem("echoagent.knowledge-sources.v1", JSON.stringify([oldSource]));
  });

  it("已保存的空配置不会从旧renderer缓存复活被移除的目录", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ exists: true, sources: [] });
    await expect(hydrateKnowledgeSources()).resolves.toEqual([]);
    expect(listKbProviders()).toEqual([]);
    expect(loadKnowledgeSourceDescriptors()).toEqual([]);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("从未建立过原生存储时继续迁移旧版本知识源", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ exists: false, sources: [] }).mockResolvedValueOnce(undefined);
    await hydrateKnowledgeSources();
    expect(invoke).toHaveBeenCalledWith("org_local_kb_sources_set", { sources: [oldSource] });
    expect(listKbProviders()).toEqual([{ id: "old", label: "旧知识源" }]);
  });

  it("桌面cache写入失败不会阻断成功读取的原生配置", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ exists: true, sources: [] });
    const cache = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota full"); });
    try {
      await expect(hydrateKnowledgeSources()).resolves.toEqual([]);
      expect(listKbProviders()).toEqual([]);
    } finally {
      cache.mockRestore();
    }
  });

  it("renderer缓存已满时连续添加不丢失先前已保存到原生的知识源", async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce({ exists: true, sources: [] })
      .mockResolvedValueOnce({ id: "first", canonicalPath: "/tmp/first" })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ id: "second", canonicalPath: "/tmp/second" })
      .mockResolvedValueOnce(undefined);
    const cache = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota full"); });
    try {
      await addLocalKnowledgeSource("/tmp/first");
      await addLocalKnowledgeSource("/tmp/second");
      expect(invoke).toHaveBeenLastCalledWith("org_local_kb_sources_set", {
        sources: [
          expect.objectContaining({ root: "/tmp/first" }),
          expect.objectContaining({ root: "/tmp/second" }),
        ],
      });
      expect(loadKnowledgeSourceDescriptors()).toHaveLength(2);
    } finally {
      cache.mockRestore();
    }
  });

  it("并发添加与移除不会覆盖其他已成功保存的知识源，重启后保持一致", async () => {
    let persisted = [oldSource];
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "org_local_kb_sources_get") return { exists: true, sources: persisted } as never;
      if (command === "filesystem_resource_identity") {
        const path = (args as { path: string }).path;
        return { id: path.split("/").pop(), canonicalPath: path } as never;
      }
      if (command === "org_local_kb_sources_set") {
        // IPC completion yields even when the filesystem is fast.
        await Promise.resolve();
        persisted = (args as { sources: typeof persisted }).sources;
      }
      return undefined as never;
    });
    await hydrateKnowledgeSources();
    await Promise.all([
      addLocalKnowledgeSource("/tmp/first"),
      addLocalKnowledgeSource("/tmp/second"),
      removeKnowledgeSource("old"),
    ]);
    expect(loadKnowledgeSourceDescriptors().map((item) => item.root).sort()).toEqual(["/tmp/first", "/tmp/second"]);
    expect(listKbProviders().map((item) => item.id).sort()).toEqual(["local-first", "local-second"]);
    resetKnowledgeSourceHydration();
    resetKbRegistry();
    expect((await hydrateKnowledgeSources()).map((item) => item.root).sort()).toEqual(["/tmp/first", "/tmp/second"]);
  });

  it("一次保存失败不会阻塞后续变更，也不把失败的知识源写入缓存", async () => {
    let fail = true;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "org_local_kb_sources_get") return { exists: true, sources: [] } as never;
      if (command === "filesystem_resource_identity") {
        const path = (args as { path: string }).path;
        return { id: path, canonicalPath: path } as never;
      }
      if (command === "org_local_kb_sources_set" && fail) { fail = false; throw new Error("磁盘暂不可写"); }
      return undefined as never;
    });
    await expect(addLocalKnowledgeSource("/tmp/failed")).rejects.toThrow("磁盘暂不可写");
    await expect(addLocalKnowledgeSource("/tmp/retry")).resolves.toMatchObject({ added: true });
    expect(loadKnowledgeSourceDescriptors().map((item) => item.root)).toEqual(["/tmp/retry"]);
  });
});
