/**
 * Subagent history/runtime panel.
 *
 * Durable lifecycle replay is the primary source. Transcript tool results are
 * retained as a compatibility/evidence source and merged by the real
 * subagent id (not the unrelated ACP tool-call id).
 */
import { useEffect, useMemo, useState } from "react";
import { ChevronDownIcon, OpenExternalIcon } from "@/foundation/components/Icon/icons";
import { useSubagentStore, type SubagentRuntime } from "@/stores/subagent-store";
import { useSessionStore, type ChatMessage } from "@/stores/session-store";
import { deriveSubagents, type SubagentActivity } from "@/lib/subagents";

interface SubagentPanelProps {
  messages?: ChatMessage[];
  cwd?: string;
  onOpenSession?: (sessionId: string, cwd?: string) => void | Promise<void>;
}

const STATUS_LABEL: Record<string, string> = {
  running: "运行中",
  in_progress: "运行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

function formatDuration(ms?: number): string {
  if (ms == null) return "";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return rs > 0 ? `${m}m${rs}s` : `${m}m`;
}

function formatTokens(n?: number): string {
  if (n == null) return "";
  if (n < 1000) return `${n}`;
  return `${(n / 1000).toFixed(1)}k`;
}

function messageText(message: ChatMessage): string {
  return message.parts
    .filter((part) => part.kind === "text")
    .map((part) => part.kind === "text" ? part.text : "")
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

interface TurnInfo {
  id: string;
  number: number;
  prompt: string;
}

function deriveTurnInfo(messages: ChatMessage[]): Map<string, TurnInfo> {
  const result = new Map<string, TurnInfo>();
  let latestUserPrompt = "";
  let nextNumber = 1;
  for (const message of messages) {
    if (message.role === "user") {
      latestUserPrompt = messageText(message);
      continue;
    }
    if (!message.promptId || result.has(message.promptId)) continue;
    result.set(message.promptId, {
      id: message.promptId,
      number: nextNumber++,
      prompt: latestUserPrompt,
    });
  }
  return result;
}

interface PanelItem {
  key: string;
  id: string;
  toolCallId?: string;
  childSessionId?: string;
  parentPromptId?: string;
  description: string;
  subagentType?: string;
  taskPrompt?: string;
  status: string;
  durationMs?: number;
  turnCount?: number;
  toolCallCount?: number;
  tokensUsed?: number;
  contextUsagePct?: number;
  toolsUsed?: string[];
  errorCount?: number;
  error?: string;
  output?: string;
  model?: string;
  persona?: string;
  role?: string;
  capabilityMode?: string;
  effectiveContextSource?: string;
  contextNormalized?: boolean;
  resumedFrom?: string;
  workflowRunId?: string;
  occurredAt?: number;
  isReplay?: boolean;
  source: "runtime" | "transcript";
}

function sameActivity(runtime: SubagentRuntime, activity: SubagentActivity): boolean {
  if (activity.subagentId && activity.subagentId === runtime.id) return true;
  if (activity.childSessionId && activity.childSessionId === runtime.childSessionId) return true;
  // Compatibility for old transcripts whose task result did not expose an id.
  return Boolean(
    activity.parentPromptId
      && activity.parentPromptId === runtime.parentPromptId
      && (activity.description || activity.name) === runtime.description
      && (!activity.subagentType || activity.subagentType === runtime.subagentType),
  );
}

function mergePanelItems(
  live: SubagentRuntime[],
  fallback: SubagentActivity[],
): PanelItem[] {
  const consumed = new Set<number>();
  const rich = live.map((runtime): PanelItem => {
    const fallbackIndex = fallback.findIndex((activity, index) =>
      !consumed.has(index) && sameActivity(runtime, activity));
    const activity = fallbackIndex >= 0 ? fallback[fallbackIndex] : undefined;
    if (fallbackIndex >= 0) consumed.add(fallbackIndex);
    return {
      key: `runtime:${runtime.id}`,
      id: runtime.id,
      toolCallId: activity?.id,
      childSessionId: runtime.childSessionId ?? activity?.childSessionId,
      parentPromptId: runtime.parentPromptId ?? activity?.parentPromptId,
      description: runtime.description || activity?.description || activity?.name || runtime.subagentType || "子代理",
      subagentType: runtime.subagentType ?? activity?.subagentType,
      taskPrompt: activity?.taskPrompt,
      status: runtime.status,
      durationMs: runtime.durationMs ?? activity?.durationMs,
      turnCount: runtime.turnCount ?? activity?.turnCount,
      toolCallCount: runtime.toolCallCount ?? activity?.toolCallCount,
      tokensUsed: runtime.tokensUsed,
      contextUsagePct: runtime.contextUsagePct,
      toolsUsed: runtime.toolsUsed,
      errorCount: runtime.errorCount,
      error: runtime.error,
      output: runtime.output ?? activity?.output,
      model: runtime.model ?? activity?.model,
      persona: runtime.persona ?? activity?.persona,
      role: runtime.role ?? activity?.role,
      capabilityMode: runtime.capabilityMode,
      effectiveContextSource: runtime.effectiveContextSource,
      contextNormalized: runtime.contextNormalized,
      resumedFrom: runtime.resumedFrom ?? activity?.resumedFrom,
      workflowRunId: runtime.workflowRunId,
      occurredAt: runtime.occurredAt,
      isReplay: runtime.isReplay,
      source: "runtime",
    };
  });

  const transcriptOnly = fallback.flatMap((activity, index): PanelItem[] => {
    if (consumed.has(index)) return [];
    return [{
      key: `transcript:${activity.id}`,
      id: activity.subagentId ?? activity.id,
      toolCallId: activity.id,
      childSessionId: activity.childSessionId,
      parentPromptId: activity.parentPromptId,
      description: activity.description || activity.name,
      subagentType: activity.subagentType,
      taskPrompt: activity.taskPrompt,
      status: activity.status,
      durationMs: activity.durationMs,
      turnCount: activity.turnCount,
      toolCallCount: activity.toolCallCount,
      output: activity.output,
      model: activity.model,
      persona: activity.persona,
      role: activity.role,
      resumedFrom: activity.resumedFrom,
      source: "transcript",
    }];
  });
  return [...rich, ...transcriptOnly];
}

function progressBits(item: PanelItem): string[] {
  const bits: string[] = [];
  if (item.turnCount != null) bits.push(`${item.turnCount} 轮`);
  if (item.toolCallCount != null) bits.push(`${item.toolCallCount} 工具`);
  const duration = formatDuration(item.durationMs);
  if (duration) bits.push(duration);
  const tokens = formatTokens(item.tokensUsed);
  if (tokens) bits.push(`${tokens} tok`);
  return bits;
}

function EvidenceDetails({
  item,
  cwd,
  onOpenSession,
}: {
  item: PanelItem;
  cwd?: string;
  onOpenSession?: SubagentPanelProps["onOpenSession"];
}) {
  const facts = [
    ["子代理 ID", item.id],
    ["子会话 ID", item.childSessionId && item.childSessionId !== item.id
      ? item.childSessionId
      : undefined],
    ["工具调用 ID", item.toolCallId],
    ["父轮次 ID", item.parentPromptId],
    ["执行状态", STATUS_LABEL[item.status] ?? item.status],
    ["执行统计", progressBits(item).join(" · ") || undefined],
    ["模型", item.model],
    ["角色", item.role],
    ["人格", item.persona],
    ["能力模式", item.capabilityMode],
    ["上下文来源", item.effectiveContextSource],
    ["续接自", item.resumedFrom],
    ["工作流 ID", item.workflowRunId],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));

  return (
    <div className="subagent-panel__details">
      {item.taskPrompt && (
        <section className="subagent-panel__detail-section">
          <h4>完整任务</h4>
          <div className="subagent-panel__detail-text">{item.taskPrompt}</div>
        </section>
      )}
      {item.output && (
        <section className="subagent-panel__detail-section">
          <h4>最终产出</h4>
          <div className="subagent-panel__detail-text subagent-panel__detail-text--output">{item.output}</div>
        </section>
      )}
      {item.error && (
        <section className="subagent-panel__detail-section">
          <h4>错误信息</h4>
          <div className="subagent-panel__detail-text subagent-panel__detail-text--error">{item.error}</div>
        </section>
      )}
      <section className="subagent-panel__detail-section">
        <h4>处理凭证</h4>
        <dl className="subagent-panel__facts">
          {facts.map(([label, value]) => (
            <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
          ))}
          {item.toolsUsed && item.toolsUsed.length > 0 && (
            <div><dt>使用工具</dt><dd>{item.toolsUsed.join("、")}</dd></div>
          )}
          {item.contextUsagePct != null && (
            <div><dt>上下文占用</dt><dd>{item.contextUsagePct}%</dd></div>
          )}
          {item.errorCount != null && item.errorCount > 0 && (
            <div><dt>错误次数</dt><dd>{item.errorCount}</dd></div>
          )}
          {item.contextNormalized != null && (
            <div><dt>上下文规范化</dt><dd>{item.contextNormalized ? "是" : "否"}</dd></div>
          )}
          {item.occurredAt != null && (
            <div><dt>记录时间</dt><dd>{new Date(item.occurredAt).toLocaleString()}</dd></div>
          )}
          <div>
            <dt>记录来源</dt>
            <dd>
              {item.source === "runtime"
                ? item.isReplay ? "持久化生命周期回放" : "实时生命周期记录"
                : "会话工具记录"}
            </dd>
          </div>
        </dl>
      </section>
      {item.childSessionId && onOpenSession && (
        <button
          type="button"
          className="subagent-panel__open-session"
          onClick={() => void onOpenSession(item.childSessionId!, cwd)}
        >
          <OpenExternalIcon size="sm" />
          打开完整工作记录
        </button>
      )}
    </div>
  );
}

export function SubagentPanel({ messages = [], cwd, onOpenSession }: SubagentPanelProps) {
  const sessionId = useSessionStore((state) => state.sessionId);
  const liveSubagents = useSubagentStore((state) =>
    sessionId ? state.getForSession(sessionId) : [],
  );
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  useEffect(() => setExpandedKey(null), [sessionId]);

  const fallbackActivities = useMemo(() => deriveSubagents(messages), [messages]);
  const items = useMemo(
    () => mergePanelItems(liveSubagents, fallbackActivities),
    [liveSubagents, fallbackActivities],
  );
  const turnInfo = useMemo(() => deriveTurnInfo(messages), [messages]);
  const groups = useMemo(() => {
    const grouped = new Map<string, PanelItem[]>();
    for (const item of items) {
      const key = item.parentPromptId || "__unassigned";
      const list = grouped.get(key) ?? [];
      list.push(item);
      grouped.set(key, list);
    }
    return [...grouped.entries()]
      .map(([id, groupItems]) => ({ id, info: turnInfo.get(id), items: groupItems }))
      .sort((a, b) => (b.info?.number ?? -1) - (a.info?.number ?? -1));
  }, [items, turnInfo]);
  const latestTurnNumber = Math.max(
    0,
    ...Array.from(turnInfo.values(), (info) => info.number),
  );

  const runningCount = items.filter((item) => item.status === "running" || item.status === "in_progress").length;
  const completedCount = items.filter((item) => item.status === "completed").length;
  const failedCount = items.filter((item) => item.status === "failed" || item.status === "cancelled").length;

  return (
    <div className="subagent-panel" role="region" aria-label="子代理运行时">
      <div className="subagent-panel__head">
        <span className="subagent-panel__title">子代理</span>
        {items.length > 0 && (
          <span className="subagent-panel__summary">
            {items.length} 个 · 运行中 {runningCount}
            {completedCount > 0 ? ` · 完成 ${completedCount}` : ""}
            {failedCount > 0 ? ` · 失败 ${failedCount}` : ""}
          </span>
        )}
      </div>
      {items.length === 0 ? (
        <div className="runtime-panel-empty">当前会话尚未派发子代理。需要并行任务时，Agent 会在这里展示实时进度。</div>
      ) : (
        <div className="subagent-panel__list">
          {groups.map((group) => (
            <section className="subagent-panel__group" key={group.id}>
              <div className="subagent-panel__group-head">
                <span>
                  {group.info
                    ? group.info.number === latestTurnNumber
                      ? `当前轮次 · 第 ${group.info.number} 轮`
                      : `历史 · 第 ${group.info.number} 轮`
                    : "未归属轮次"}
                </span>
                {group.info?.prompt && <span title={group.info.prompt}>{group.info.prompt}</span>}
              </div>
              <ul>
                {group.items.map((item) => {
                  const expanded = expandedKey === item.key;
                  const bits = progressBits(item);
                  return (
                    <li key={item.key} className={`subagent-panel__item subagent-panel__row--${item.status}`}>
                      <button
                        type="button"
                        className="subagent-panel__row"
                        aria-expanded={expanded}
                        onClick={() => setExpandedKey(expanded ? null : item.key)}
                      >
                        <span className="subagent-panel__dot" aria-hidden="true" />
                        <span className="subagent-panel__info">
                          <span className="subagent-panel__name-line">
                            <span className="subagent-panel__name">{item.description}</span>
                            {item.subagentType && <span className="subagent-panel__type">{item.subagentType}</span>}
                          </span>
                          {bits.length > 0 && (
                            <span className="subagent-panel__progress">
                              {bits.map((bit) => <span key={bit}>{bit}</span>)}
                              {item.contextUsagePct != null && item.contextUsagePct > 0 && (
                                <span className="subagent-panel__ctx">{item.contextUsagePct}% ctx</span>
                              )}
                            </span>
                          )}
                        </span>
                        <span className="subagent-panel__status">{STATUS_LABEL[item.status] ?? item.status}</span>
                        <ChevronDownIcon className={`subagent-panel__chevron${expanded ? " is-open" : ""}`} size="sm" />
                      </button>
                      {expanded && <EvidenceDetails item={item} cwd={cwd} onOpenSession={onOpenSession} />}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
