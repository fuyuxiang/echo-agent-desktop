import { useMeetingStore } from '@/stores/meetingStore'
import { useMeetingRecorder } from '@/hooks/useMeetingRecorder'
import styles from './recorder-indicator.module.scss'

/**
 * 全局录音指示器(2026-08 P0-8 修复)
 *
 * 录音生命周期不再依赖 Chat 页 unmount:useMeetingRecorder 已经把管线提升为
 * 模块级单例,这里把指示器放到 AppLayout 的标题栏,任何页面都能看到录音状态
 * 并提供全局停止入口。
 *
 * 设计要点:
 * - 仅在 recording=true 时渲染(避免闲置时占空间)
 * - 红点 + 计时器让用户清楚"正在录音"
 * - 显眼的停止按钮(录音是高频隐私敏感操作,绝不能藏起来)
 */
export function RecorderIndicator(): React.JSX.Element | null {
  const recording = useMeetingStore((s) => s.recording)
  const elapsedMs = useMeetingStore((s) => s.elapsedMs)
  const audioSource = useMeetingStore((s) => s.audioSource)
  const activeMeetingId = useMeetingStore((s) => s.activeMeetingId)
  const { stop } = useMeetingRecorder()

  if (!recording) return null

  const totalSec = Math.floor(elapsedMs / 1000)
  const mm = Math.floor(totalSec / 60).toString().padStart(2, '0')
  const ss = (totalSec % 60).toString().padStart(2, '0')

  const handleStop = (): void => {
    void stop()
  }

  return (
    <div
      className={styles.indicator}
      role="status"
      aria-live="polite"
      data-testid="recorder-indicator"
      data-recording="true"
    >
      <span className={styles.dot} aria-hidden="true" />
      <span className={styles.label}>REC</span>
      <span className={styles.clock} aria-label={`已录制 ${mm}:${ss}`}>
        {mm}:{ss}
      </span>
      <span className={styles.source}>{audioSource === 'mic+system' ? '🎙+🔊' : '🎙'}</span>
      <button
        type="button"
        className={styles.stopBtn}
        onClick={handleStop}
        disabled={!activeMeetingId}
        title="停止录音"
      >
        停止
      </button>
    </div>
  )
}
