import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { addLocalKnowledgeSource, hydrateKnowledgeSources, loadKnowledgeSourceDescriptors, resetKnowledgeSourceHydration } from "../kb-source-storage";
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
});
