import { useEffect, useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import type { MeetingDTO, SegmentDTO, SummaryDTO } from '@shared/types/meeting'
import { formatClock } from './format'
import styles from './meeting.module.scss'

export default function MeetingDetail(): React.JSX.Element {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const [meeting, setMeeting] = useState<MeetingDTO | null>(null)
  const [segments, setSegments] = useState<SegmentDTO[]>([])
  const [summary, setSummary] = useState<SummaryDTO | null>(null)
  const [tab, setTab] = useState<'summary' | 'transcript'>('summary')

  const load = useCallback(async () => {
    const r = await window.api.meeting.get(id)
    setMeeting(r.meeting)
    setSegments(r.segments)
    setSummary(r.summary)
  }, [id])
  useEffect(() => {
    void load()
  }, [load])

  const onRemove = async (): Promise<void> => {
    if (!window.confirm('删除该会议及其录音?此操作不可撤销')) return
    await window.api.meeting.remove(id)
    navigate('/meeting')
  }

  const onRegenSummary = async (): Promise<void> => {
    try {
      const { segments } = await window.api.meeting.get(id)
      const { generateSummary } = await import('@/services/meeting/summarize')
      await generateSummary(id, segments)
      await load()
    } catch {
      /* 重新生成失败不崩页,用户可再次点击重试 */
    }
  }

  const onRetryDiarize = async (): Promise<void> => {
    try {
      await window.api.meeting.diarize(id)
      await load()
    } catch {
      /* 说话人分离失败不崩页,用户可再次点击重试 */
    }
  }

  if (!meeting) return <div className={styles.page}>加载中…</div>
  return (
    <div className={styles.page}>
      <div className={styles.detailHead}>
        <button onClick={() => navigate('/meeting')}>←</button>
        <span className={styles.title}>{meeting.title ?? '未命名会议'}</span>
        <span className={styles.meta}>{formatClock(meeting.durationMs)}</span>
        <button className={styles.danger} onClick={onRemove}>
          删除
        </button>
      </div>
      <div className={styles.tabs}>
        <button
          className={tab === 'summary' ? styles.tabActive : ''}
          onClick={() => setTab('summary')}
        >
          纪要
        </button>
        <button
          className={tab === 'transcript' ? styles.tabActive : ''}
          onClick={() => setTab('transcript')}
        >
          全文转写
        </button>
      </div>
      {tab === 'summary' ? (
        summary ? (
          <div className={styles.summary}>
            <ReactMarkdown>{summary.summary}</ReactMarkdown>
            {summary.keyPoints.length > 0 && (
              <>
                <h4>关键点</h4>
                <ul>
                  {summary.keyPoints.map((k, i) => (
                    <li key={i}>{k}</li>
                  ))}
                </ul>
              </>
            )}
            {summary.actionItems.length > 0 && (
              <>
                <h4>待办</h4>
                <ul>
                  {summary.actionItems.map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        ) : (
          <div className={styles.empty}>
            {meeting.status === 'processing' ? (
              '正在生成纪要…'
            ) : (
              <>
                <div>暂无纪要</div>
                <button onClick={onRegenSummary}>重新生成纪要</button>
              </>
            )}
          </div>
        )
      ) : (
        <div className={styles.transcript}>
          <button onClick={onRetryDiarize}>重试说话人分离</button>
          {segments.map((s) => (
            <div key={s.id} className={styles.seg}>
              {s.speaker && <span className={styles.speaker}>{s.speaker}</span>}
              <span className={styles.time}>{formatClock(s.startMs)}</span>
              <span>{s.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
