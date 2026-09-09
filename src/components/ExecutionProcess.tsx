import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Markdown, type MarkdownConfig } from "./markdown/index";
import { ToolCallCard } from "./ToolCallCard";
import { useTheme } from "./ThemeProvider";
import type { MessagePart, ToolCallView } from "@/stores/session-store";
import {
  formatProcessDuration,
  summarizeExecutionProcess,
} from "@/lib/execution-process";
import { pickThinkingCompanion } from "@/lib/loading-tips";
import type { KnowledgeTurnTrace } from "@/stores/knowledge-store";

interface ExecutionProcessProps {
  parts: MessagePart[];
  active: boolean;
  startedAt?: number;
  completedAt?: number;
  stopReason?: string;
  cancelTrigger?: string;
  cancellationCategory?: string;
  agentResult?: string;
  markdownConfig?: MarkdownConfig;
  onOpenTool?: (tool: ToolCallView) => void;
  knowledgeTrace?: KnowledgeTurnTrace;
  onOpenKnowledgePath?: (path: string) => void;
}

/**
 * One desktop-friendly process group per assistant turn. It keeps the live
 * state readable, folds automatically when a turn completes, and delegates
 * dense tool output to the existing right-side detail panel.
 */
export function ExecutionProcess({
  parts,
  active,
  startedAt,
  completedAt,
  stopReason,
  cancelTrigger,
  cancellationCategory,
  agentResult,
  markdownConfig,
  onOpenTool,
  knowledgeTrace,
  onOpenKnowledgePath,
}: ExecutionProcessProps) {
  const { theme } = useTheme();
  const bodyId = useId();
  const [open, setOpen] = useState(active);
  const [now, setNow] = useState(() => Date.now());
  const [thinkingCompanion] = useState(() => pickThinkingCompanion());
  const previousActive = useRef(active);
  const userToggled = useRef(false);
  const summary = useMemo(
    () => summarizeExecutionProcess(
      parts,
      active,
      stopReason,
      cancellationCategory,
      cancelTrigger,
    ),
    [active, cancellationCategory, cancelTrigger, parts, stopReason],
  );

  useEffect(() => {
    if (!startedAt || !active) return;
    const update = () => setNow(Date.now());
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [active, startedAt]);

  useEffect(() => {
    if (active && !previousActive.current) {
      userToggled.current = false;
      setOpen(true);
    } else if (!active && previousActive.current && !userToggled.current) {
      setOpen(false);
    }
    previousActive.current = active;
  }, [active]);

  const thoughtParts = parts.filter(
    (part): part is Extract<MessagePart, { kind: "thought" }> => part.kind === "thought",
  );
  const visibleParts = parts.filter((part) => part.kind !== "thought");
  const duration = startedAt
    ? formatProcessDuration(Math.max(0, (completedAt ?? now) - startedAt))
    : null;
  const meta: string[] = [];
  if (summary.toolCount > 0) {
    meta.push(active
      ? `${summary.completedToolCount}/${summary.toolCount} 项`
      : `${summary.toolCount} 项操作`);
  } else if (summary.thoughtCount > 0) {
    meta.push(`${summary.thoughtCount} 段思考过程`);
  }
  if (summary.changedFiles.length > 0) meta.push(`${summary.changedFiles.length} 个文件`);
  if (duration) meta.push(duration);
  if (knowledgeTrace?.personal?.state === "used") {
    meta.unshift(`${knowledgeTrace.personal.resultCount} 个知识片段`);
  }
  const knowledgeOnly = visibleParts.length === 0
    && thoughtParts.length === 0
    && Boolean(knowledgeTrace);
  const title = knowledgeTrace?.personal?.state === "searching"
    ? "正在检索个人知识库"
    : knowledgeOnly && !active
      ? "知识检索完成"
      : summary.title;

  return (
    <section className={`execution-process execution-process--${summary.state}`}>
      <button
        type="button"
        className="execution-process__header"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => {
          userToggled.current = true;
          setOpen((value) => !value);
        }}
      >
        <span className="execution-process__status" aria-hidden="true" />
        <span className="execution-process__heading">
          <span className="execution-process__title" role="status" aria-live="polite">
            {title}
          </span>
          {meta.length > 0 && (
            <span className="execution-process__meta">{meta.join(" · ")}</span>
          )}
        </span>
        <span
          className={`execution-process__chevron${open ? " execution-process__chevron--open" : ""}`}
          aria-hidden="true"
        >
          ›
        </span>
      </button>

      {open && (
        <div className="execution-process__body" id={bodyId}>
          {!active && agentResult && (
            <p className="execution-process__terminal-detail" role="alert">
              {agentResult}
            </p>
          )}
          {knowledgeTrace && (
            <KnowledgeTrace
              trace={knowledgeTrace}
              onOpenPath={onOpenKnowledgePath}
            />
          )}
          {visibleParts.length === 0 && thoughtParts.length > 0 && (
            <p className="execution-process__empty">
              {active
                ? thinkingCompanion
                : "本轮没有调用外部操作，可展开查看思考过程。"}
            </p>
          )}
          {visibleParts.map((part, index) => {
            if (part.kind === "text") {
              return (
                <div className="execution-process__commentary" key={`text-${index}`}>
                  <Markdown
                    complete={!active}
                    markdownTheme="reasoning"
                    theme={theme}
                    config={markdownConfig}
                  >
                    {part.text}
                  </Markdown>
                </div>
              );
            }
            if (part.kind === "tool_call") {
              return (
                <ToolCallCard
                  key={part.toolCall.toolCallId || `tool-${index}`}
                  tc={part.toolCall}
                  onOpen={onOpenTool}
                />
              );
            }
            return null;
          })}

          {thoughtParts.length > 0 && (
            <details className="execution-process__reasoning">
              <summary>
                思考过程{thoughtParts.length > 1 ? ` · ${thoughtParts.length} 段` : ""}
              </summary>
              <div className="execution-process__reasoning-body">
                {thoughtParts.map((part, index) => (
                  <Markdown
                    key={index}
                    complete={!active}
                    markdownTheme="reasoning"
                    theme={theme}
                    config={markdownConfig}
                  >
                    {part.text}
                  </Markdown>
                ))}
              </div>
            </details>
          )}

          {summary.toolCount > 0 && onOpenTool && (
            <p className="execution-process__hint">选择操作可在右侧查看输入、输出和文件变更</p>
          )}
        </div>
      )}
    </section>
  );
}

function KnowledgeTrace({
  trace,
  onOpenPath,
}: {
  trace: KnowledgeTurnTrace;
  onOpenPath?: (path: string) => void;
}) {
  const personal = trace.personal;
  const personalVisible = personal && personal.state !== "idle";
  const organizationUnavailable = trace.organization?.state === "unavailable";
  if (!personalVisible && !organizationUnavailable) return null;

  return (
    <div className="knowledge-trace" aria-label="知识检索过程">
      {personal?.state === "searching" && (
        <div className="knowledge-trace__status is-searching">
          <span aria-hidden="true" />
          正在从个人知识库检索相关片段…
        </div>
      )}
      {personal?.state === "no-match" && (
        <div className="knowledge-trace__status">
          已搜索 {personal.sourceCount} 个个人知识源，未找到相关内容
        </div>
      )}
      {personal?.state === "blocked" && (
        <div className="knowledge-trace__status is-warning">个人知识未使用：{personal.message}</div>
      )}
      {personal?.state === "error" && (
        <div className="knowledge-trace__status is-warning">个人知识检索失败：{personal.message}</div>
      )}
      {personal?.state === "used" && (
        <details className="knowledge-trace__results" open>
          <summary>
            已向模型提供 {personal.resultCount} 个相关片段
            <small>来自 {personal.sourceCount} 个知识源</small>
          </summary>
          <div className="knowledge-trace__items">
            {personal.items.map((item, index) => {
              const lineRange = item.startLine
                ? item.startLine === item.endLine || !item.endLine
                  ? `第 ${item.startLine} 行`
                  : `第 ${item.startLine}–${item.endLine} 行`
                : null;
              const body = (
                <>
                  <strong>{item.title}</strong>
                  {(item.sourceLabel || lineRange) && (
                    <small>{[item.sourceLabel, lineRange].filter(Boolean).join(" · ")}</small>
                  )}
                  {item.snippet && <span>{item.snippet}</span>}
                  {item.path && <code>{item.path}</code>}
                </>
              );
              return item.path && onOpenPath ? (
                <button
                  key={`${item.path}-${index}`}
                  type="button"
                  className="knowledge-trace__item"
                  title={`打开 ${item.path}`}
                  onClick={() => onOpenPath(item.path!)}
                >
                  {body}
                </button>
              ) : (
                <div className="knowledge-trace__item" key={`${item.title}-${index}`}>{body}</div>
              );
            })}
          </div>
        </details>
      )}
      {organizationUnavailable && (
        <div className="knowledge-trace__status is-warning">
          {trace.organization?.message ?? "组织知识库当前不可用，本次未使用"}
        </div>
      )}
    </div>
  );
}
