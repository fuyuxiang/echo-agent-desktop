/**
 * 本地用量统计与配额 —— weixinpay 计费的本地可移植替代。
 *
 * EchoAgent 用 weixinpay 做计费(依赖腾讯支付后端);EchoAgent 是 BYOK(用户自带 API Key,
 * 无计费通道)。这里用「本地用量统计 + 配额面板」替代:记录每次 API 调用的 token 消耗,
 * 提供日/周/月统计 + 可选配额告警(接近上限时提醒)。纯函数 + localStorage 持久化。
 */

/** 一条用量记录。 */
export interface UsageRecord {
  /** ISO 日期(YYYY-MM-DD)。 */
  date: string;
  /** 模型 id。 */
  modelId: string;
  /** 提示 token。 */
  promptTokens: number;
  /** 补全 token。 */
  completionTokens: number;
  /** 估算费用(可选,用户配置费率后计算)。 */
  cost?: number;
  /** 时间戳(ms)。 */
  ts: number;
  /** 会话 id；新记录用于去重与追踪，旧数据可能没有。 */
  sessionId?: string;
}

/** 用量统计汇总。 */
export interface UsageSummary {
  /** 总 token。 */
  totalTokens: number;
  /** 总提示 token。 */
  totalPrompt: number;
  /** 总补全 token。 */
  totalCompletion: number;
  /** 总估算费用。 */
  totalCost: number;
  /** 记录数。 */
  count: number;
  /** 按模型分组。 */
  byModel: Record<string, { tokens: number; cost: number; count: number }>;
  /** 按日期分组(YYYY-MM-DD)。 */
  byDate: Record<string, { tokens: number; cost: number; count: number }>;
}

/** 配额配置。 */
export interface QuotaConfig {
  /** 配额周期("daily" | "monthly")。 */
  period: "daily" | "monthly";
  /** token 上限。 */
  tokenLimit: number;
  /** 达到上限后的桌面端手动发送策略；旧配置默认仅提醒。 */
  enforcement?: "warn" | "block";
  /** 费率表(modelId → 每千 token 价格)。 */
  rates?: Record<string, { prompt: number; completion: number }>;
}

const STORAGE_KEY = "echoagent.usage";
const QUOTA_KEY = "echoagent.quota";
const SNAPSHOT_KEY = "echoagent.usage-snapshots.v1";
const QUOTA_ALERT_KEY = "echoagent.quota-alert.v1";

interface CumulativeSnapshot {
  inputTokens: number;
  outputTokens: number;
}

type CumulativeSnapshots = Record<string, CumulativeSnapshot>;

function localDateParts(date: Date): { year: number; month: number; day: number } {
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
  };
}

/** 取本机时区的今日日期，避免东八区凌晨被记到前一天。 */
export function todayKey(date = new Date()): string {
  const { year, month, day } = localDateParts(date);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** 取本机时区的当月(YYYY-MM)。 */
export function monthKey(date = new Date()): string {
  const { year, month } = localDateParts(date);
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** 估算单次调用费用(按费率表)。 */
export function estimateCost(
  modelId: string,
  promptTokens: number,
  completionTokens: number,
  rates?: Record<string, { prompt: number; completion: number }>,
): number | undefined {
  if (!rates || !rates[modelId]) return undefined;
  const r = rates[modelId];
  return (promptTokens / 1000) * r.prompt + (completionTokens / 1000) * r.completion;
}

/** 读取全部用量记录(按时间顺序)。 */
export function loadUsage(): UsageRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as UsageRecord[]) : [];
  } catch {
    return [];
  }
}

/** 追加一条用量记录(自动算费用)。 */
export function recordUsage(
  records: UsageRecord[],
  entry: { modelId: string; promptTokens: number; completionTokens: number; sessionId?: string },
  config?: QuotaConfig,
): UsageRecord[] {
  const cost = estimateCost(entry.modelId, entry.promptTokens, entry.completionTokens, config?.rates);
  const record: UsageRecord = {
    date: todayKey(),
    modelId: entry.modelId,
    promptTokens: entry.promptTokens,
    completionTokens: entry.completionTokens,
    cost,
    ts: Date.now(),
    sessionId: entry.sessionId,
  };
  const next = [...records, record];
  saveUsage(next);
  return next;
}

/**
 * EchoAgent 的 `echo.agent/session/usage` 返回会话累计值，不是单轮增量。
 * 这里按会话保存上一个累计快照，只记录差值，避免每轮把历史 token
 * 重复计入配额。引擎重启导致计数器回退时，将当前值视为新起点。
 */
export function recordCumulativeUsage(
  records: UsageRecord[],
  entry: {
    sessionId: string;
    modelId: string;
    inputTokens: number;
    outputTokens: number;
  },
  config?: QuotaConfig,
): UsageRecord[] {
  const snapshots = loadCumulativeSnapshots();
  const previous = snapshots[entry.sessionId];
  const countersReset = !!previous && (
    entry.inputTokens < previous.inputTokens || entry.outputTokens < previous.outputTokens
  );
  const baseInput = previous && !countersReset ? previous.inputTokens : 0;
  const baseOutput = previous && !countersReset ? previous.outputTokens : 0;
  const promptTokens = Math.max(0, entry.inputTokens - baseInput);
  const completionTokens = Math.max(0, entry.outputTokens - baseOutput);

  snapshots[entry.sessionId] = {
    inputTokens: Math.max(0, entry.inputTokens),
    outputTokens: Math.max(0, entry.outputTokens),
  };
  saveCumulativeSnapshots(snapshots);

  if (promptTokens === 0 && completionTokens === 0) return records;
  return recordUsage(records, {
    sessionId: entry.sessionId,
    modelId: entry.modelId,
    promptTokens,
    completionTokens,
  }, config);
}

function loadCumulativeSnapshots(): CumulativeSnapshots {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as CumulativeSnapshots : {};
  } catch {
    return {};
  }
}

function saveCumulativeSnapshots(snapshots: CumulativeSnapshots): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshots));
  } catch {
    /* quota / 隐私模式 —— 静默降级 */
  }
}

/** 持久化。 */
function saveUsage(records: UsageRecord[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch {
    /* quota / 隐私模式 — 静默降级 */
  }
}

/** 清空用量(测试/重置用)。 */
export function clearUsage(): UsageRecord[] {
  saveUsage([]);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(SNAPSHOT_KEY);
      window.localStorage.removeItem(QUOTA_ALERT_KEY);
    } catch {
      /* noop */
    }
  }
  return [];
}

/** 汇总用量(全部或按日期范围过滤)。 */
export function summarizeUsage(records: UsageRecord[], dateFilter?: { from: string; to: string }): UsageSummary {
  const filtered = dateFilter
    ? records.filter((r) => r.date >= dateFilter.from && r.date <= dateFilter.to)
    : records;
  const byModel: Record<string, { tokens: number; cost: number; count: number }> = {};
  const byDate: Record<string, { tokens: number; cost: number; count: number }> = {};
  let totalPrompt = 0;
  let totalCompletion = 0;
  let totalCost = 0;
  for (const r of filtered) {
    const tokens = r.promptTokens + r.completionTokens;
    totalPrompt += r.promptTokens;
    totalCompletion += r.completionTokens;
    totalCost += r.cost ?? 0;
    if (!byModel[r.modelId]) byModel[r.modelId] = { tokens: 0, cost: 0, count: 0 };
    byModel[r.modelId].tokens += tokens;
    byModel[r.modelId].cost += r.cost ?? 0;
    byModel[r.modelId].count += 1;
    if (!byDate[r.date]) byDate[r.date] = { tokens: 0, cost: 0, count: 0 };
    byDate[r.date].tokens += tokens;
    byDate[r.date].cost += r.cost ?? 0;
    byDate[r.date].count += 1;
  }
  return {
    totalTokens: totalPrompt + totalCompletion,
    totalPrompt,
    totalCompletion,
    totalCost,
    count: filtered.length,
    byModel,
    byDate,
  };
}

/** 检查配额:返回当前周期已用比例(0–1)及是否超限。 */
export function checkQuota(records: UsageRecord[], config: QuotaConfig): {
  used: number;
  limit: number;
  pct: number;
  exceeded: boolean;
  nearLimit: boolean;
} {
  const key = config.period === "daily" ? todayKey() : monthKey();
  const periodRecords = records.filter((r) =>
    config.period === "daily" ? r.date === key : r.date.startsWith(key),
  );
  const used = periodRecords.reduce((s, r) => s + r.promptTokens + r.completionTokens, 0);
  const hasLimit = config.tokenLimit > 0;
  const pct = hasLimit ? used / config.tokenLimit : 0;
  return {
    used,
    limit: config.tokenLimit,
    pct: Math.round(pct * 100),
    exceeded: hasLimit && used >= config.tokenLimit,
    nearLimit: hasLimit && pct >= 0.8 && pct < 1,
  };
}

/** 是否应暂停桌面端手动发送。未配置/0 上限永远不拦截。 */
export function isQuotaBlocking(records: UsageRecord[], config: QuotaConfig | null): boolean {
  return !!config
    && config.enforcement === "block"
    && config.tokenLimit > 0
    && checkQuota(records, config).exceeded;
}

/**
 * 在当前周期首次跨过 80% / 100% 时返回告警级别。
 * 记录阈值状态避免每轮对话重复通知。
 */
export function consumeQuotaAlert(
  records: UsageRecord[],
  config: QuotaConfig | null,
): "near" | "exceeded" | null {
  if (!config || config.tokenLimit <= 0 || typeof window === "undefined") return null;
  const quota = checkQuota(records, config);
  const level = quota.exceeded ? "exceeded" : quota.nearLimit ? "near" : null;
  if (!level) return null;
  const periodKey = config.period === "daily" ? todayKey() : monthKey();
  const key = `${config.period}:${periodKey}:${config.tokenLimit}`;
  try {
    const previous = JSON.parse(window.localStorage.getItem(QUOTA_ALERT_KEY) ?? "null") as
      | { key?: string; level?: "near" | "exceeded" }
      | null;
    if (previous?.key === key && (previous.level === "exceeded" || previous.level === level)) {
      return null;
    }
    window.localStorage.setItem(QUOTA_ALERT_KEY, JSON.stringify({ key, level }));
  } catch {
    // Storage unavailable: preserve the alert rather than hiding a quota event.
  }
  return level;
}

/** 读取配额配置。 */
export function loadQuotaConfig(): QuotaConfig | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(QUOTA_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as QuotaConfig;
  } catch {
    return null;
  }
}

/** 保存配额配置。 */
export function saveQuotaConfig(config: QuotaConfig): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(QUOTA_KEY, JSON.stringify(config));
    window.localStorage.removeItem(QUOTA_ALERT_KEY);
  } catch {
    /* noop */
  }
}
