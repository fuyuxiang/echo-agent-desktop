import { describe, expect, it } from "vitest";
import { filterModelsByRuntimeCatalog } from "../agent-client";
import type { ModelOptionRow } from "../agent-client";

const row = (id: string): ModelOptionRow => ({
  id,
  label: id,
  providerKind: "custom",
  providerId: "p1",
});

describe("filterModelsByRuntimeCatalog", () => {
  const options = [row("model-a"), row("model-hidden")];

  it("剔除 Runtime 目录中不存在的模型（被 hidden/disabled 过滤掉的条目）", () => {
    expect(filterModelsByRuntimeCatalog(options, ["model-a"])).toEqual([row("model-a")]);
  });

  it("Runtime 目录尚未读取时保留磁盘列表，避免冷启动时选择器空白", () => {
    expect(filterModelsByRuntimeCatalog(options, [])).toEqual(options);
  });

  it("id 完全不匹配时回退到磁盘列表，不返回空选择器", () => {
    expect(filterModelsByRuntimeCatalog(options, ["unrelated"])).toEqual(options);
  });

  it("保留磁盘列表的顺序", () => {
    const three = [row("m1"), row("m2"), row("m3")];
    expect(filterModelsByRuntimeCatalog(three, ["m3", "m1"])).toEqual([row("m1"), row("m3")]);
  });
});

describe("filterModelsByRuntimeCatalog 品牌模型兜底", () => {
  it("即使 Runtime 目录里有品牌模型，也不出现在选择器中", () => {
    const options = [row("gpt-4o"), row("grok-4.6")];
    expect(filterModelsByRuntimeCatalog(options, ["gpt-4o", "grok-4.6"])).toEqual([
      row("gpt-4o"),
    ]);
  });

  it("Runtime 目录未读取时也过滤品牌模型", () => {
    const options = [row("gpt-4o"), row("grok-4.5")];
    expect(filterModelsByRuntimeCatalog(options, [])).toEqual([row("gpt-4o")]);
  });

  it("id 不匹配回退到磁盘列表时仍不放行品牌模型", () => {
    const options = [row("deepseek-chat"), row("grok-4.6")];
    expect(filterModelsByRuntimeCatalog(options, ["unrelated"])).toEqual([
      row("deepseek-chat"),
    ]);
  });

  it("磁盘列表只有品牌模型时返回空选择器（没有可用模型可提供）", () => {
    expect(filterModelsByRuntimeCatalog([row("grok-4.6"), row("grok-4.5")], [])).toEqual([]);
  });
});
