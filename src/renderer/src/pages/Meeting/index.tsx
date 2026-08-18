import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import type { MeetingDTO } from '@shared/types/meeting'
import { formatClock } from './format'
import styles from './meeting.module.scss'

/** 状态 key → i18n key 映射,避免在 JSX 里写大段硬编码中文 */
const STATUS_KEY: Record<string, string> = {
  recording: 'meeting.status.recording',
  processing: 'meeting.status.processing',
  done: 'meeting.status.done',
  failed: 'meeting.status.failed'
}

export default function MeetingPage(): React.JSX.Element {
  const { t } = useTranslation()
  const [meetings, setMeetings] = useState<MeetingDTO[]>([])
  const navigate = useNavigate()

  useEffect(() => {
    void window.api.meeting.list().then((r) => setMeetings(r.meetings))
  }, [])

  const statusLabel = (s: string): string => {
    const key = STATUS_KEY[s]
    return key ? t(key) : s
  }

  return (
    <div className={styles.page}>
      <h2>{t('meeting.title')}</h2>
      {meetings.length === 0 ? (
        <div className={styles.empty}>{t('meeting.empty')}</div>
      ) : (
        <ul className={styles.list}>
          {meetings.map((m) => (
            <li key={m.id} className={styles.item} onClick={() => navigate(`/meeting/${m.id}`)}>
              <span className={styles.title}>{m.title ?? t('meeting.untitled')}</span>
              <span className={styles.meta}>
                {new Date(m.startedAt).toLocaleString()} · {formatClock(m.durationMs)} ·{' '}
                {statusLabel(m.status)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
