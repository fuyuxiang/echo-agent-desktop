import { describe, expect, it } from "vitest";
import {
  NEUTRAL_MODEL_LABEL,
  isUpstreamBrandedModelId,
  sanitizeModelLabel,
  stripUpstreamBrandedIds,
} from "../model-branding";

const LEGACY_MODEL_BRAND = ["g", "rok"].join("");
const LEGACY_VENDOR_BRAND = ["x", "ai"].join("");
const legacyModel = (version: string) => `${LEGACY_MODEL_BRAND}-${version}`;

describe("isUpstreamBrandedModelId", () => {
  it("拦下内置默认目录里的模型 id 与展示名", () => {
    for (const value of [
      legacyModel("4.6"),
      legacyModel("4.5"),
      `${LEGACY_MODEL_BRAND.toUpperCase()} 4.6`,
      `${LEGACY_MODEL_BRAND.toUpperCase()} 4.5`,
    ]) {
      expect(isUpstreamBrandedModelId(value)).toBe(true);
    }
  });

  it("大小写不敏感", () => {
    for (const value of [
      LEGACY_MODEL_BRAND.toUpperCase(),
      `${LEGACY_MODEL_BRAND.slice(0, 1).toUpperCase()}${LEGACY_MODEL_BRAND.slice(1)}`,
      `${LEGACY_MODEL_BRAND.slice(0, 1)}R${LEGACY_MODEL_BRAND.slice(2).toUpperCase()}-4.6`,
      LEGACY_VENDOR_BRAND.toUpperCase(),
    ]) {
      expect(isUpstreamBrandedModelId(value)).toBe(true);
    }
  });

  it("拦下历史供应商名的常见变体", () => {
    for (const value of [
      `${LEGACY_VENDOR_BRAND}-${LEGACY_MODEL_BRAND}-build`,
      `${LEGACY_VENDOR_BRAND.slice(0, 1)}.${LEGACY_VENDOR_BRAND.slice(1)}/v1-model`,
      `${LEGACY_MODEL_BRAND}-code-fast-1`,
    ]) {
      expect(isUpstreamBrandedModelId(value)).toBe(true);
    }
  });

  it("放行用户自己配置的常见第三方模型", () => {
    for (const value of [
      "gpt-4o",
      "gpt-5.1",
      "deepseek-chat",
      "deepseek-reasoner",
      "qwen-max",
      "claude-sonnet-4",
      "kimi-k2",
      "glm-4.6",
      "my-gateway-model",
    ]) {
      expect(isUpstreamBrandedModelId(value)).toBe(false);
    }
  });

  it("空值视为不带品牌，由调用点决定空值文案", () => {
    expect(isUpstreamBrandedModelId(undefined)).toBe(false);
    expect(isUpstreamBrandedModelId(null)).toBe(false);
    expect(isUpstreamBrandedModelId("")).toBe(false);
  });

  it("固化已接受的误伤：自定义命名含品牌子串时同样被拦", () => {
    // 刻意的取舍 —— 漏一个品牌名的代价高于误伤一个自定义命名。这只影响显示，
    // 不影响该模型能否被选中和调用（就绪判定与请求校验用未过滤目录）。
    expect(isUpstreamBrandedModelId(`my-${LEGACY_MODEL_BRAND}-proxy`)).toBe(true);
    expect(isUpstreamBrandedModelId(`${LEGACY_MODEL_BRAND}king-model`)).toBe(true);
  });
});

describe("stripUpstreamBrandedIds", () => {
  it("剔除品牌 id 并保留其余项的顺序", () => {
    expect(
      stripUpstreamBrandedIds(["gpt-4o", legacyModel("4.6"), "deepseek-chat", legacyModel("4.5")]),
    ).toEqual(["gpt-4o", "deepseek-chat"]);
  });

  it("全是品牌 id 时返回空数组", () => {
    expect(stripUpstreamBrandedIds([legacyModel("4.6"), legacyModel("4.5")])).toEqual([]);
  });

  it("没有品牌 id 时原样返回", () => {
    expect(stripUpstreamBrandedIds(["gpt-4o", "qwen-max"])).toEqual(["gpt-4o", "qwen-max"]);
  });
});

describe("sanitizeModelLabel", () => {
  it("品牌 id 换成中性文案", () => {
    expect(sanitizeModelLabel(legacyModel("4.6"))).toBe(NEUTRAL_MODEL_LABEL);
  });

  it("非品牌 id 原样返回", () => {
    expect(sanitizeModelLabel("deepseek-chat")).toBe("deepseek-chat");
  });

  it("空值用调用点给的 fallback", () => {
    expect(sanitizeModelLabel(undefined, "未指定")).toBe("未指定");
    expect(sanitizeModelLabel("", "未指定")).toBe("未指定");
  });

  it("未传 fallback 时空值也回落到中性文案", () => {
    expect(sanitizeModelLabel(undefined)).toBe(NEUTRAL_MODEL_LABEL);
  });
});
