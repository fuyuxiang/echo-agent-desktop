/**
 * 回溯/分叉工具栏 — 显示在 ChatView 底部（composer 正上方）。
 *
 * 两个能力：
 *  - Rewind（回溯）：调 `echo.agent/rewind/{points,execute}`，回到指定 prompt 索引。
 *    支持 mode: conversation（仅回退对话）/ files（仅文件）/ all（全量，含对话+文件+记忆）。
 *  - Fork（分叉）：调 `echo.agent/session/fork`，复制会话到新 id 探索不同方向。
 *
 * 增强点（对齐 EchoAgent）：
 *  - 时间线视图：每个回溯点显示时间、prompt 预览、assistant 回复预览、工具调用徽章。
 *  - 文件/记忆变更徽章：标记哪些步骤产生了文件改动或记忆写入。
 *  - 三种模式按钮：仅对话 / 仅文件 / 全量。
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import {
  rewindExecute,
  rewindPoints,
  sessionFork,
} from "@/lib/agent-client";
import type { RewindPoint } from "@/lib/types";
import {
  ClockIcon,
  ChevronDownIcon,
  GitBranchIcon,
} from "@/foundation/components/Icon/icons";
import { useModalFocus } from "@/lib/use-modal-focus";
import { useAppDialog } from "./AppDialog";

/** Rewind mode options matching EchoAgent's echo.agent/rewind/execute mode param.
 *  NOTE: EchoAgent's RewindMode enum only has All/ConversationOnly/FilesOnly —
 *  there is no "memory"-only mode (all already includes memory). Don't add
 *  "memory" here or EchoAgent's serde will reject it at runtime. */
type RewindMode = "conversation" | "files" | "all";

const MODE_LABELS: Record<RewindMode, string> = {
  conversation: "仅对话",
  files: "仅文件",
  all: "全量",
};

const MODE_TITLES: Record<RewindMode, string> = {
  conversation: "回退对话历史，不影响文件",
  files: "回退文件改动，不影响对话",
  all: "回退所有（对话 + 文件 + 记忆）",
};

interface RewindBarProps {
  sessionId: string;
  cwd?: string;
  onForked?: (newSessionId: string, sourceSessionId: string, sourceCwd?: string) => void;
  onRewound?: (sessionId: string) => void | Promise<void>;
  onToast?: (msg: string) => void;
}

export function RewindBar({
  sessionId,
  cwd,
  onForked,
  onRewound,
  onToast,
}: RewindBarProps) {
  const [open, setOpen] = useState(false);
  const [points, setPoints] = useState<RewindPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Currently selected mode for the next rewind action. */
  const [selectedMode, setSelectedMode] = useState<RewindMode>("all");
  const activeSessionRef = useRef(sessionId);
  const requestGenerationRef = useRef(0);
  const dialogId = useId();
  const dialogTitleId = useId();
  const dialogRef = useModalFocus<HTMLDivElement>(open, () => setOpen(false));
  const { requestConfirmation, dialog } = useAppDialog(sessionId);

  const loadPoints = useCallback(async () => {
    const targetSessionId = sessionId;
    const generation = ++requestGenerationRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const next = await rewindPoints(targetSessionId);
      if (
        activeSessionRef.current === targetSessionId
        && requestGenerationRef.current === generation
      ) {
        setPoints(next);
      }
    } catch (error) {
      if (
        activeSessionRef.current === targetSessionId
        && requestGenerationRef.current === generation
      ) {
        setPoints([]);
        setLoadError(String(error).replace(/^Error:\s*/, ""));
      }
    } finally {
      if (
        activeSessionRef.current === targetSessionId
        && requestGenerationRef.current === generation
      ) {
        setLoading(false);
      }
    }
  }, [sessionId]);

  useLayoutEffect(() => {
    activeSessionRef.current = sessionId;
    requestGenerationRef.current += 1;
    setOpen(false);
    setPoints([]);
    setLoadError(null);
    setLoading(false);
    setBusy(false);
    setSelectedMode("all");
  }, [sessionId]);

  useEffect(() => {
    if (open && points.length === 0 && !loading && !loadError) void loadPoints();
  }, [open, points.length, loading, loadError, loadPoints]);

  const handleRewind = async (idx: number) => {
    const targetSessionId = sessionId;
    const targetMode = selectedMode;
    setBusy(true);
    try {
      await rewindExecute(targetSessionId, idx, targetMode, true);
      const label = MODE_LABELS[targetMode];
      onToast?.(`已回溯（${label}）`);
      await onRewound?.(targetSessionId);
      if (activeSessionRef.current === targetSessionId) setOpen(false);
    } catch (e) {
      onToast?.(`回溯失败：${String(e).replace(/^Error:\s*/, "")}`);
    } finally {
      if (activeSessionRef.current === targetSessionId) setBusy(false);
    }
  };

  const handleFork = () => {
    const targetSessionId = sessionId;
    const targetCwd = cwd;
    requestConfirmation({
      title: "分叉此会话？",
      description: "当前会话将复制为一个新会话，原会话与其内容会完整保留。",
      confirmLabel: "创建分叉",
      action: async () => {
        setBusy(true);
        try {
          const newId = await sessionFork(targetSessionId, targetCwd);
          onToast?.(`已分叉到新会话 ${newId.slice(0, 8)}`);
          onForked?.(newId, targetSessionId, targetCwd);
        } finally {
          if (activeSessionRef.current === targetSessionId) setBusy(false);
        }
      },
      onError: (error) => onToast?.(`分叉失败：${String(error).replace(/^Error:\s*/, "")}`),
    });
  };

  return (
    <div className="rewind-bar">
      <button
        type="button"
        className="rewind-bar__btn"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        title="回溯到历史某一步"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={dialogId}
      >
        <ClockIcon size="sm" /> 回溯
        <ChevronDownIcon size="sm" />
      </button>
      <button
        type="button"
        className="rewind-bar__btn"
        onClick={handleFork}
        disabled={busy}
        title="分叉此会话"
      >
        <GitBranchIcon size="sm" /> 分叉
      </button>

      {open && (
        <div
          ref={dialogRef}
          id={dialogId}
          className="rewind-bar__dropdown rewind-bar__dropdown--timeline"
          role="dialog"
          aria-labelledby={dialogTitleId}
          tabIndex={-1}
        >
          {/* Header with refresh */}
          <div className="rewind-bar__header">
            <span id={dialogTitleId}>回溯时间线</span>
            <button
              type="button"
              className="rewind-bar__refresh"
              onClick={loadPoints}
              disabled={loading}
              aria-label="刷新回溯点"
            >
              {loading ? "加载中…" : "刷新"}
            </button>
          </div>

          {/* Mode selector */}
          <div className="rewind-bar__modes">
            {(Object.keys(MODE_LABELS) as RewindMode[]).map((mode) => (
              <button
                type="button"
                key={mode}
                className={
                  "rewind-bar__mode-btn" +
                  (selectedMode === mode ? " rewind-bar__mode-btn--active" : "")
                }
                onClick={() => setSelectedMode(mode)}
                title={MODE_TITLES[mode]}
                aria-pressed={selectedMode === mode}
                data-modal-initial-focus={selectedMode === mode ? "" : undefined}
              >
                {MODE_LABELS[mode]}
              </button>
            ))}
          </div>

          {/* Timeline list */}
          {loading && <div className="rewind-bar__empty">加载中…</div>}
          {!loading && loadError && (
            <div className="rewind-bar__empty" role="alert">
              <div>加载回溯点失败：{loadError}</div>
              <button type="button" onClick={() => void loadPoints()}>重试</button>
            </div>
          )}
          {!loading && !loadError && points.length === 0 && (
            <div className="rewind-bar__empty">无回溯点（会话刚创建）</div>
          )}
          <ul className="rewind-bar__timeline">
            {points.map((p) => (
              <li key={p.promptIndex} className="rewind-bar__timeline-item">
                {/* Timeline dot + connector line */}
                <div className="rewind-bar__timeline-rail">
                  <span className="rewind-bar__timeline-dot" />
                </div>

                {/* Content card */}
                <div className="rewind-bar__timeline-card">
                  <div className="rewind-bar__timeline-time">
                    {p.timestamp
                      ? new Date(p.timestamp).toLocaleString()
                      : `#${p.promptIndex}`}
                  </div>
                  {p.promptPreview && (
                    <div className="rewind-bar__timeline-prompt">
                      {p.promptPreview.length > 80
                        ? p.promptPreview.slice(0, 80) + "…"
                        : p.promptPreview}
                    </div>
                  )}
                  {p.messagePreview && (
                    <div className="rewind-bar__timeline-response">
                      💬{" "}
                      {p.messagePreview.length > 60
                        ? p.messagePreview.slice(0, 60) + "…"
                        : p.messagePreview}
                    </div>
                  )}

                  {/* Badges: file changes / memory changes / tool names */}
                  <div className="rewind-bar__timeline-badges">
                    {p.hasFileChanges && (
                      <span className="rewind-bar__badge rewind-bar__badge--file">
                        📄 文件
                      </span>
                    )}
                    {p.hasMemoryChanges && (
                      <span className="rewind-bar__badge rewind-bar__badge--memory">
                        🧠 记忆
                      </span>
                    )}
                    {p.toolNames && p.toolNames.length > 0 && (
                      <span className="rewind-bar__badge rewind-bar__badge--tool">
                        🔧 {p.toolNames.slice(0, 3).join(", ")}
                        {p.toolNames.length > 3 && ` +${p.toolNames.length - 3}`}
                      </span>
                    )}
                  </div>

                  {/* Rewind action button */}
                  <button
                    type="button"
                    className="rewind-bar__timeline-action"
                    onClick={() => handleRewind(p.promptIndex)}
                    disabled={busy}
                  >
                    回溯到此处（{MODE_LABELS[selectedMode]}）
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {dialog}
    </div>
  );
}
