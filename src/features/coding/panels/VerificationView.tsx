import { AlertTriangle, CheckCircle2, CircleSlash, Clock, LoaderCircle, Play, Square } from "lucide-react";

import { verificationLabel } from "../store/workbench-store";
import type { DetectedCommand, VerificationRecord } from "../lib/types";

interface VerificationViewProps {
  records: VerificationRecord[];
  detected: DetectedCommand[];
  running: boolean;
  hasTask: boolean;
  onRun: (command: DetectedCommand) => void;
  onRunAll: () => void;
  onOpenOutput: (record: VerificationRecord) => void;
  onCancel?: () => void;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs}ms`;
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
}

/**
 * Verification runs and their results.
 *
 * A record's verdict comes from its exit code, and `structured: false` is shown
 * explicitly — a passing run whose output could not be parsed must not look like
 * a clean structured result.
 */
export function VerificationView({
  records,
  detected,
  running,
  hasTask,
  onRun,
  onRunAll,
  onOpenOutput,
  onCancel,
}: VerificationViewProps) {
  const latest = [...records].reverse();

  return (
    <div className="coding-panel">
      <div className="coding-panel__actions">
        <button type="button" disabled={!hasTask || running || detected.length === 0} onClick={onRunAll}>
          {running ? <LoaderCircle size={12} className="is-spinning" /> : <Play size={12} />}
          运行全部验证
        </button>
        {running && onCancel && (
          <button type="button" onClick={onCancel}>
            <Square size={12} /> 停止验证
          </button>
        )}
        {detected.map((command) => (
          <button
            key={command.command}
            type="button"
            disabled={!hasTask || running}
            onClick={() => onRun(command)}
            title={command.command}
          >
            {command.label}
          </button>
        ))}
        {detected.length === 0 && (
          <span className="coding-panel__hint">未从工程清单识别到验证命令</span>
        )}
      </div>

      {latest.length === 0 ? (
        <div className="coding-panel__empty">尚未运行构建或测试</div>
      ) : (
        <div className="coding-panel__list">
          {latest.map((record) => (
            <button
              key={record.id}
              type="button"
              className={`coding-verification is-${record.status}`}
              onClick={() => onOpenOutput(record)}
            >
              {record.status === "passed" ? (
                <CheckCircle2 size={13} />
              ) : record.status === "running" ? (
                <LoaderCircle size={13} className="is-spinning" />
              ) : record.status === "cancelled" ? (
                <CircleSlash size={13} />
              ) : record.status === "timed_out" ? (
                <Clock size={13} />
              ) : (
                <AlertTriangle size={13} />
              )}
              <em>{verificationLabel(record.kind)}</em>
              <code>{record.command}</code>
              <span>
                {record.testSummary
                  ? `${record.testSummary.passed} 通过 / ${record.testSummary.failed} 失败${
                      record.testSummary.skipped > 0 ? ` / ${record.testSummary.skipped} 跳过` : ""
                    }`
                  : record.status === "passed"
                    ? "通过"
                    : record.status === "timed_out"
                      ? "超时"
                      : record.status === "cancelled"
                        ? "已取消"
                        : "失败"}
              </span>
              {!record.structured && record.kind === "test" && (
                <b title="未能解析测试摘要，结论仅依据退出码">未结构化</b>
              )}
              <small>
                退出码 {record.exitCode ?? "无"} · {formatDuration(record.durationMs)}
              </small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
