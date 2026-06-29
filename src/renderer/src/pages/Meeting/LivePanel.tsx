import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useMeetingRecorder } from '@/hooks/useMeetingRecorder'
import { formatClock } from '@/pages/Meeting/format'
import styles from './live-panel.module.scss'

export function LivePanel(): React.JSX.Element | null {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const rec = useMeetingRecorder()
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [rec.segments, rec.partial])

  if (!rec.recording) return null
  if (rec.minimized) {
    return (
      <button className={styles.pill} onClick={rec.toggleMinimize}>
        <span className={styles.dot} /> {formatClock(rec.elapsedMs)}
      </button>
    )
  }

  const onStop = async (): Promise<void> => {
    if (!window.confirm(t('chat.meeting.confirmStop'))) return
    const id = rec.activeMeetingId
    await rec.stop() // 内部已 stop + diarize
    if (!id) return
    navigate(`/meeting/${id}`)
    // 后台生成纪要(失败静默,详情页可手动重试)
    try {
      const { meeting, segments } = await window.api.meeting.get(id)
      const { generateSummary } = await import('@/services/meeting/summarize')
      await generateSummary(id, segments, meeting?.title ?? '')
    } catch {
      /* 详情页显示「暂无纪要」,留作手动重试 */
    }
  }

  return (
    <div className={styles.overlay}>
      <div className={styles.panel}>
        <div className={styles.bar}>
          <span className={styles.status}>
            <span className={styles.dot} /> {t('chat.meeting.recording')} {formatClock(rec.elapsedMs)}
          </span>
          <div className={styles.actions}>
            <button onClick={rec.toggleMinimize}>{t('chat.meeting.minimize')}</button>
            <button className={styles.stopBtn} onClick={onStop}>
              {t('chat.meeting.stop')}
            </button>
          </div>
        </div>
        <div className={styles.source}>
          {rec.audioSource === 'mic+system'
            ? t('chat.meeting.micSystem')
            : t('chat.meeting.micOnly')}
        </div>
        <div className={styles.transcript} ref={scrollRef}>
          {rec.segments.map((s) => (
            <div key={s.id} className={styles.seg}>
              <span className={styles.time}>{formatClock(s.startMs)}</span>
              <span>{s.text}</span>
            </div>
          ))}
          {rec.partial && <div className={styles.partial}>{rec.partial}</div>}
        </div>
      </div>
    </div>
  )
}
