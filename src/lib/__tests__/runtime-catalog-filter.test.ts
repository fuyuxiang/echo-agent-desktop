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
