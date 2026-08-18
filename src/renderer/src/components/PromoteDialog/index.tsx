import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useOrgStore, isOrgReady } from '@/stores/orgStore'
import { toast } from '@/components/Toast'
import type { MemoryKind, PromotionSource } from '@shared/types/org'
import styles from './promote-dialog.module.scss'

// 类型 → i18n key(label / hint)映射
const KIND_KEY: Record<MemoryKind, { label: string; hint: string }> = {
  decision: { label: 'promote.kind.decision', hint: 'promote.kind.hint.decision' },
  convention: { label: 'promote.kind.convention', hint: 'promote.kind.hint.convention' },
  fact: { label: 'promote.kind.fact', hint: 'promote.kind.hint.fact' },
  pitfall: { label: 'promote.kind.pitfall', hint: 'promote.kind.hint.pitfall' },
  howto: { label: 'promote.kind.howto', hint: 'promote.kind.hint.howto' }
}

/**
 * 沉淀对话框 —— 知识双向流动的入口。
 *
 * 没有这个入口,服务端的审核队列永远是空的:管理员上传是一条腿,员工把
 * 日常工作里的结论提上来是另一条腿,后者才是让知识库不过时的部分。
 *
 * 三处触发:问答结论、会议纪要候选、任务完成。共用这一个对话框。
 */
export function PromoteDialog({
  source,
  defaultContent,
  defaultKind = 'decision',
  evidence,
  onClose,
  onDone
}: {
  source: PromotionSource
  defaultContent: string
  defaultKind?: MemoryKind
  evidence?: { type: string; id: string; loc?: string }[]
  onClose: () => void
  onDone?: () => void
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const status = useOrgStore((s) => s.status)
  const scopes = useOrgStore((s) => s.scopes)
  const promote = useOrgStore((s) => s.promote)

  const [kind, setKind] = useState<MemoryKind>(defaultKind)
  const [content, setContent] = useState(defaultContent)
  const [rationale, setRationale] = useState('')
  const [targetScope, setTargetScope] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!targetScope && scopes.length > 0) {
      // 推迟到下一个 tick,避免在 effect body 同步触发 setState
      queueMicrotask(() => {
        setTargetScope((cur) => {
          if (cur) return cur
          // 默认投团队而非全公司:组织层的门槛更高,让用户主动选择升到那一层。
          const team = scopes.find((s) => s.kind === 'team')
          return team?.id ?? scopes[0].id
        })
      })
    }
  }, [scopes, targetScope])

  if (!isOrgReady(status)) return null

  const submit = async (): Promise<void> => {
    const text = content.trim()
    if (!text) {
      toast.error(t('promote.fillContent'))
      return
    }
    if (!targetScope) {
      toast.error(t('promote.pickScope'))
      return
    }
    setBusy(true)
    try {
      const res = await promote({
        payloadType: 'memory',
        payload: { kind, content: text, rationale: rationale.trim() || undefined, evidence },
        source,
        targetScope
      })
      if (!res.ok) {
        toast.error(res.error ?? t('promote.submitFailed'))
        return
      }
      // 离线入队要说清楚,否则用户以为已经生效了。
      toast.success(res.queued ? t('promote.queued') : t('promote.submitted'))
      onDone?.()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <h3 className={styles.title}>{t('promote.title')}</h3>
        <p className={styles.desc}>{t('promote.desc')}</p>

        <label className={styles.label}>{t('promote.type')}</label>
        <div className={styles.kinds}>
          {(Object.keys(KIND_KEY) as MemoryKind[]).map((k) => (
            <button
              key={k}
              type="button"
              className={kind === k ? styles.kindActive : styles.kind}
              onClick={() => setKind(k)}
              title={t(KIND_KEY[k].hint)}
            >
              {t(KIND_KEY[k].label)}
            </button>
          ))}
        </div>
        <div className={styles.kindHint}>{t(KIND_KEY[kind].hint)}</div>

        <label className={styles.label}>
          {t('promote.content')}
          <span className={styles.counter}>{content.length}/2000</span>
        </label>
        <textarea
          className={styles.textarea}
          rows={4}
          maxLength={2000}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder={t('promote.contentPlaceholder')}
        />

        <label className={styles.label}>{t('promote.rationale')}</label>
        <textarea
          className={styles.textarea}
          rows={2}
          maxLength={2000}
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
          placeholder={t('promote.rationalePlaceholder')}
        />

        <label className={styles.label}>{t('promote.shareScope')}</label>
        <select
          className={styles.select}
          value={targetScope}
          onChange={(e) => setTargetScope(e.target.value)}
        >
          {scopes.map((s) => (
            <option key={s.id} value={s.id}>
              {s.kind === 'org'
                ? t('promote.scopeOrg')
                : t('promote.scopeTeam', { name: s.name })}
            </option>
          ))}
        </select>

        <div className={styles.actions}>
          <button type="button" className={styles.ghost} onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button type="button" className={styles.primary} onClick={() => void submit()} disabled={busy}>
            {busy ? t('promote.submitting') : t('promote.submitReview')}
          </button>
        </div>
      </div>
    </div>
  )
}
