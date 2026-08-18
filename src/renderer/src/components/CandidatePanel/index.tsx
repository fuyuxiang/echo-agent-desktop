import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useOrgStore, isOrgReady } from '@/stores/orgStore'
import { toast } from '@/components/Toast'
import type { KnowledgeCandidate } from '@shared/types/org'
import type { SegmentDTO as Segment } from '@shared/types/meeting'
import styles from './candidate-panel.module.scss'

// 候选类型 → i18n key 映射
const KIND_KEY: Record<string, string> = {
  decision: 'candidate.kind.decision',
  convention: 'candidate.kind.convention',
  pitfall: 'candidate.kind.pitfall'
}

function fmtTime(ms: number | null): string {
  if (ms == null) return ''
  const total = Math.floor(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/**
 * 会议候选知识面板。
 *
 * 开完会顺手勾几条,比事后专门整理文档的转化率高一个量级 —— 这是"知识从
 * 日常工作自动沉淀"的实际落点。
 *
 * 默认全不勾选:让用户主动选择比默认全选更安全。默认全选时用户一路点确认,
 * 低质条目就进了组织库,而组织库的噪音会污染所有人的后续问答。
 */
export function CandidatePanel({
  segments,
  meetingId,
  meetingTitle
}: {
  segments: Segment[]
  meetingId: string
  meetingTitle: string
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const status = useOrgStore((s) => s.status)
  const scopes = useOrgStore((s) => s.scopes)
  const promote = useOrgStore((s) => s.promote)
  const init = useOrgStore((s) => s.init)

  const [candidates, setCandidates] = useState<KnowledgeCandidate[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [targetScope, setTargetScope] = useState('')
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    if (!targetScope && scopes.length > 0) {
      // 推迟到下一个 tick,避免在 effect body 同步触发 setState
      queueMicrotask(() => {
        setTargetScope((cur) => {
          if (cur) return cur
          const team = scopes.find((s) => s.kind === 'team')
          return team?.id ?? scopes[0].id
        })
      })
    }
  }, [scopes, targetScope])

  const extract = useCallback(async () => {
    if (segments.length === 0) {
      toast.error(t('candidate.noTranscripts'))
      return
    }
    setLoading(true)
    try {
      const list = await window.api.meeting.extractCandidates(segments)
      setCandidates(list)
      setSelected(new Set())
      if (list.length === 0) {
        toast.info(t('candidate.noCandidates'))
      }
    } catch (e) {
      toast.error(t('candidate.extractFailed', { message: (e as Error).message }))
      setCandidates([])
    } finally {
      setLoading(false)
    }
  }, [segments, t])

  // 未接入企业服务器时整块不显示:个人版用户看到一个提交后无处可去的
  // 按钮只会困惑。
  if (!isOrgReady(status)) return null

  const toggle = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const submit = async (): Promise<void> => {
    if (!candidates || selected.size === 0) return
    if (!targetScope) {
      toast.error(t('candidate.pickScope'))
      return
    }
    setSubmitting(true)
    let ok = 0
    let queued = 0
    let failed = 0
    try {
      for (const c of candidates) {
        if (!selected.has(c.id)) continue
        const content = (edits[c.id] ?? c.content).trim()
        if (!content) continue
        const res = await promote({
          payloadType: 'memory',
          payload: {
            kind: c.kind,
            content,
            rationale: c.rationale || undefined,
            // 依据里带上会议与时间点,让审核人能回溯原始发言
            evidence: [
              {
                type: 'meeting',
                id: meetingId,
                loc: c.startMs != null ? `${meetingTitle} ${fmtTime(c.startMs)}` : meetingTitle
              }
            ]
          },
          source: 'meeting',
          targetScope
        })
        if (!res.ok) failed++
        else if (res.queued) queued++
        else ok++
      }

      if (failed > 0) {
        toast.error(t('candidate.submitFailed', { count: failed }))
      }
      if (ok > 0 || queued > 0) {
        toast.success(
          queued > 0
            ? t('candidate.queued', { count: queued })
            : t('candidate.submitted', { count: ok })
        )
        setDone(true)
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className={styles.wrap}>
      <header className={styles.head}>
        <div>
          <h4 className={styles.title}>{t('candidate.title')}</h4>
          <p className={styles.desc}>{t('candidate.desc')}</p>
        </div>
        {candidates === null && (
          <button
            type="button"
            className={styles.primary}
            disabled={loading}
            onClick={() => void extract()}
          >
            {loading ? t('candidate.extracting') : t('candidate.extract')}
          </button>
        )}
      </header>

      {candidates !== null && candidates.length === 0 && (
        <div className={styles.emptyBox}>
          <p>{t('candidate.empty')}</p>
          <button type="button" className={styles.linkBtn} onClick={() => void extract()}>
            {t('candidate.retry')}
          </button>
        </div>
      )}

      {candidates !== null && candidates.length > 0 && (
        <>
          <ul className={styles.list}>
            {candidates.map((c) => {
              const checked = selected.has(c.id)
              return (
                <li key={c.id} className={checked ? styles.itemChecked : styles.item}>
                  <label className={styles.row}>
                    <input type="checkbox" checked={checked} onChange={() => toggle(c.id)} />
                    <span className={styles.kind}>{t(KIND_KEY[c.kind] ?? 'candidate.kind.other')}</span>
                    {c.speaker && <span className={styles.speaker}>{c.speaker}</span>}
                    {c.startMs != null && <span className={styles.ts}>{fmtTime(c.startMs)}</span>}
                  </label>

                  {checked ? (
                    <textarea
                      className={styles.editArea}
                      rows={2}
                      maxLength={2000}
                      value={edits[c.id] ?? c.content}
                      onChange={(e) => setEdits({ ...edits, [c.id]: e.target.value })}
                    />
                  ) : (
                    <div className={styles.content}>{c.content}</div>
                  )}

                  {c.rationale && (
                    <div className={styles.rationale}>
                      {t('candidate.rationale', { text: c.rationale })}
                    </div>
                  )}
                  {c.quote && <blockquote className={styles.quote}>{c.quote}</blockquote>}
                </li>
              )
            })}
          </ul>

          <footer className={styles.foot}>
            <label className={styles.scopeLabel}>
              {t('candidate.shareTo')}
              <select
                className={styles.select}
                value={targetScope}
                onChange={(e) => setTargetScope(e.target.value)}
              >
                {scopes.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.kind === 'org' ? t('candidate.orgScope') : t('candidate.teamScope', { name: s.name })}
                  </option>
                ))}
              </select>
            </label>
            <span className={styles.count}>{t('candidate.selected', { count: selected.size })}</span>
            <button
              type="button"
              className={styles.primary}
              disabled={selected.size === 0 || submitting || done}
              onClick={() => void submit()}
            >
              {done
                ? t('candidate.submittedDone')
                : submitting
                  ? t('candidate.submitting')
                  : t('candidate.submitReview')}
            </button>
          </footer>
        </>
      )}
    </section>
  )
}
