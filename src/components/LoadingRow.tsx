import { useEffect, useRef, useState } from "react";
import { formatProcessDuration } from "@/lib/execution-process";
import { LOADING_TIPS, pickLoadingTip } from "@/lib/loading-tips";

const UNDERSTANDING_DURATION_MS = 1_500;
const COMPANION_DELAY_MS = 3_500;
const COMPANION_ROTATION_MS = 14_000;
const BACKGROUND_HINT_DELAY_MS = 8_000;

/**
 * The primary line is factual; the slower secondary line adds a little warmth
 * without pretending the client knows the model's percentage complete.
 */
export function LoadingRow({ startedAt }: { startedAt?: number }) {
  const origin = useRef(startedAt ?? Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [tip, setTip] = useState(() => pickLoadingTip());

  useEffect(() => {
    const update = () => setNow(Date.now());
    const timer = window.setInterval(update, 500);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion) return;
    const timer = window.setInterval(() => {
      setTip((previous) => {
        const next = pickLoadingTip();
        if (next !== previous || LOADING_TIPS.length < 2) return next;
        const index = LOADING_TIPS.indexOf(next);
        return LOADING_TIPS[(index + 1) % LOADING_TIPS.length];
      });
    }, COMPANION_ROTATION_MS);
    return () => window.clearInterval(timer);
  }, []);

  const elapsed = Math.max(0, now - origin.current);
  const phase = elapsed < UNDERSTANDING_DURATION_MS
    ? "正在理解任务"
    : "正在等待模型响应";

  return (
    <div className="msg__loading">
      <div className="msg__loading-status">
        <span className="msg__loading-main echo-shining-text" role="status" aria-live="polite">
          {phase}
        </span>
        {elapsed >= BACKGROUND_HINT_DELAY_MS && (
          <span className="msg__loading-context">
            <span aria-hidden="true">·</span>
            <span>{formatProcessDuration(elapsed)}</span>
            <span className="msg__loading-background-hint">可切换会话，任务会继续运行</span>
          </span>
        )}
      </div>
      {elapsed >= COMPANION_DELAY_MS && (
        <div className="msg__loading-tip" aria-live="off">
          <span aria-hidden="true">✦</span>
          <span key={tip}>{tip}</span>
        </div>
      )}
    </div>
  );
}
