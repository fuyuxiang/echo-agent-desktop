import { useEffect, useRef, useState } from "react";
import { formatProcessDuration } from "@/lib/execution-process";

const REQUEST_DURATION_MS = 1_500;
const BACKGROUND_HINT_DELAY_MS = 8_000;

/**
 * Show elapsed waiting time and the supported background behavior.
 */
export function LoadingRow({ startedAt }: { startedAt?: number }) {
  const origin = useRef(startedAt ?? Date.now());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const update = () => setNow(Date.now());
    const timer = window.setInterval(update, 500);
    return () => window.clearInterval(timer);
  }, []);

  const elapsed = Math.max(0, now - origin.current);
  const phase = elapsed < REQUEST_DURATION_MS
    ? "正在请求模型"
    : "正在等待模型响应";

  return (
    <div className="msg__loading">
      <div className="msg__loading-status">
        <span className="msg__loading-main" role="status" aria-live="polite">
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
    </div>
  );
}
