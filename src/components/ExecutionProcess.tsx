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
            {summary.title}
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
