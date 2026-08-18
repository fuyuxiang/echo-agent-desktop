import { useEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams, useNavigate } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import type { MeetingDTO, SegmentDTO, SummaryDTO } from '@shared/types/meeting'
import { formatClock } from './format'
import { toast } from '@/components/Toast'
import { CandidatePanel } from '@/components/CandidatePanel'
import styles from './meeting.module.scss'

export default function MeetingDetail(): React.JSX.Element {
  const { t } = useTranslation()
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
    // load 内的 setState 均在 await 之后,非同步级联;规则无法越过 async 边界,此处显式豁免
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  const onRemove = async (): Promise<void> => {
    if (!window.confirm(t('meetingDetail.deleteConfirm'))) return
    await window.api.meeting.remove(id)
    navigate('/meeting')
  }

  const onRegenSummary = async (): Promise<void> => {
    try {
      const { meeting, segments } = await window.api.meeting.get(id)
      const { generateSummary } = await import('@/services/meeting/summarize')
      await generateSummary(id, segments, meeting?.title ?? '')
      await load()
    } catch {
      // 用户主动点"重新生成":失败给即时反馈,可再次点击重试
      toast.error(t('meetingDetail.summaryFailed'))
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

  if (!meeting) return <div className={styles.page}>{t('meetingDetail.loading')}</div>
  return (
    <div className={styles.page}>
      <div className={styles.detailHead}>
        <button onClick={() => navigate('/meeting')}>←</button>
        <span className={styles.title}>
          {meeting.title ?? t('meeting.untitled')}
        </span>
        <span className={styles.meta}>{formatClock(meeting.durationMs)}</span>
        <button className={styles.danger} onClick={onRemove}>
          {t('common.delete')}
        </button>
      </div>
      <div className={styles.tabs}>
        <button
          className={tab === 'summary' ? styles.tabActive : ''}
          onClick={() => setTab('summary')}
        >
          {t('meetingDetail.tabSummary')}
        </button>
        <button
          className={tab === 'transcript' ? styles.tabActive : ''}
          onClick={() => setTab('transcript')}
        >
          {t('meetingDetail.tabTranscript')}
        </button>
      </div>
      {tab === 'summary' ? (
        summary ? (
          <div className={styles.summary}>
            <ReactMarkdown>{summary.summary}</ReactMarkdown>
            {summary.keyPoints.length > 0 && (
              <>
                <h4>{t('meetingDetail.keyPoints')}</h4>
                <ul>
                  {summary.keyPoints.map((k, i) => (
                    <li key={i}>{k}</li>
                  ))}
                </ul>
              </>
            )}
            {summary.actionItems.length > 0 && (
              <>
                <h4>{t('meetingDetail.actionItems')}</h4>
                <ul>
                  {summary.actionItems.map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ul>
              </>
            )}
            {/* 纪要之后紧跟沉淀入口:刚看完结论正是最想留存它的时候。
                未接入企业服务器时该组件自身不渲染。 */}
            <CandidatePanel
              segments={segments}
              meetingId={meeting.id}
              meetingTitle={meeting.title ?? t('meeting.untitled')}
            />
          </div>
        ) : (
          <div className={styles.empty}>
            {meeting.status === 'processing' ? (
              t('meetingDetail.generatingSummary')
            ) : (
              <>
                <div>{t('meetingDetail.noSummary')}</div>
                <button onClick={onRegenSummary}>
                  {t('meetingDetail.regenSummary')}
                </button>
              </>
            )}
          </div>
        )
      ) : (
        <div className={styles.transcript}>
          <button onClick={onRetryDiarize}>{t('meetingDetail.retryDiarize')}</button>
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
