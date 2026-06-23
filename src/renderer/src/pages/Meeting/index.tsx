import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { MeetingDTO } from '@shared/types/meeting'
import { formatClock } from './format'
import styles from './meeting.module.scss'

export default function MeetingPage(): React.JSX.Element {
  const [meetings, setMeetings] = useState<MeetingDTO[]>([])
  const navigate = useNavigate()
  useEffect(() => {
    void window.api.meeting.list().then((r) => setMeetings(r.meetings))
  }, [])
  const statusLabel = (s: string): string =>
    ({ recording: '记录中', processing: '处理中', done: '已完成', failed: '失败' })[s] ?? s
  return (
    <div className={styles.page}>
      <h2>会议</h2>
      {meetings.length === 0 ? (
        <div className={styles.empty}>暂无会议记录</div>
      ) : (
        <ul className={styles.list}>
          {meetings.map((m) => (
            <li key={m.id} className={styles.item} onClick={() => navigate(`/meeting/${m.id}`)}>
              <span className={styles.title}>{m.title ?? '未命名会议'}</span>
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
