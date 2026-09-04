/**
 * 上游供应商品牌词的兜底过滤。
 *
 * EchoAgent 是 BYOK 产品：可用模型全部来自用户自己配置的连接。内置 Runtime 仍带有
 * 上游默认模型目录，并且会在若干条路径上把这些条目并入有效目录（内置默认目录叠加、
 * 远端 /v1/models 拉取、目录缺失时的 bundled fallback）。`agent_runtime` 已在源头
 * 关掉这两条主路径，本模块是最后一道兜底：即使上游升级改了字段名让源头防护失效，
 * 品牌词也不会出现在界面上。
 *
 * 匹配策略是刻意从严的子串匹配：漏掉一个品牌名的代价高于误伤一个自定义命名。用户
 * 若把自建网关模型命名成含这些子串的名字，显示上会被替换为中性占位文案 —— 这只影响
 * 显示，不影响该模型能否被选中和调用（就绪判定与请求校验始终使用未过滤的目录）。
 */

/** 上游品牌词。小写比较，按子串匹配。 */
const UPSTREAM_BRAND_TOKENS = ["grok", "xai", "x.ai", "spacexai"] as const;

/** 品牌模型在界面上的中性替代文案。 */
export const NEUTRAL_MODEL_LABEL = "其他模型";

/**
 * 判断一个模型 id / 名称是否带上游品牌词。
 *
 * 空值视为“不带品牌”，由各调用点自己决定空值怎么显示。
 */
export function isUpstreamBrandedModelId(value: string | undefined | null): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase();
  return UPSTREAM_BRAND_TOKENS.some((token) => normalized.includes(token));
}

/** 从列表中剔除所有带品牌词的模型 id。 */
export function stripUpstreamBrandedIds(values: readonly string[]): string[] {
  return values.filter((value) => !isUpstreamBrandedModelId(value));
}

/**
 * 把带品牌词的 id 换成中性文案，其余原样返回。
 *
 * `fallback` 用于调用点想要的空值文案（如「未指定」）。
 */
export function sanitizeModelLabel(
  value: string | undefined | null,
  fallback = NEUTRAL_MODEL_LABEL,
): string {
  if (!value) return fallback;
  return isUpstreamBrandedModelId(value) ? NEUTRAL_MODEL_LABEL : value;
}
