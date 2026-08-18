import { useEffect, useState } from 'react'
import { useOrgStore, isOrgReady } from '@/stores/orgStore'
import { toast } from '@/components/Toast'
import type { MemoryKind, PromotionSource } from '@shared/types/org'
import styles from './promote-dialog.module.scss'

const KINDS: { value: MemoryKind; label: string; hint: string }[] = [
  { value: 'decision', label: '决策', hint: '会上定下来的事' },
  { value: 'convention', label: '约定', hint: '团队默认这么做' },
  { value: 'fact', label: '事实', hint: '客观的数字、规则' },
  { value: 'pitfall', label: '坑点', hint: '踩过的坑,别人别再踩' },
  { value: 'howto', label: '操作方法', hint: '具体怎么做' }
]

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
      toast.error('请填写要沉淀的内容')
      return
    }
    if (!targetScope) {
      toast.error('请选择共享范围')
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
        toast.error(res.error ?? '提交失败')
        return
      }
      // 离线入队要说清楚,否则用户以为已经生效了。
      toast.success(
        res.queued
          ? '已存入本地队列,联网后会自动提交'
          : '已提交,管理员审核通过后全员可检索到'
      )
      onDone?.()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <h3 className={styles.title}>沉淀为组织知识</h3>
        <p className={styles.desc}>
          提交后需管理员审核。审核人可能会调整措辞后通过。
        </p>

        <label className={styles.label}>类型</label>
        <div className={styles.kinds}>
          {KINDS.map((k) => (
            <button
              key={k.value}
              type="button"
              className={kind === k.value ? styles.kindActive : styles.kind}
              onClick={() => setKind(k.value)}
              title={k.hint}
            >
              {k.label}
            </button>
          ))}
        </div>
        <div className={styles.kindHint}>{KINDS.find((k) => k.value === kind)?.hint}</div>

        <label className={styles.label}>
          内容
          <span className={styles.counter}>{content.length}/2000</span>
        </label>
        <textarea
          className={styles.textarea}
          rows={4}
          maxLength={2000}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="一句话说清结论,如:采购申请统一走线上流程,纸质单据不再受理"
        />

        <label className={styles.label}>依据(可选)</label>
        <textarea
          className={styles.textarea}
          rows={2}
          maxLength={2000}
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
          placeholder="为什么成立。写清楚更容易通过审核,也让后来人信得过"
        />

        <label className={styles.label}>共享范围</label>
        <select
          className={styles.select}
          value={targetScope}
          onChange={(e) => setTargetScope(e.target.value)}
        >
          {scopes.map((s) => (
            <option key={s.id} value={s.id}>
              {s.kind === 'org' ? '全公司' : `${s.name}(团队)`}
            </option>
          ))}
        </select>

        <div className={styles.actions}>
          <button type="button" className={styles.ghost} onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className={styles.primary} onClick={() => void submit()} disabled={busy}>
            {busy ? '提交中…' : '提交审核'}
          </button>
        </div>
      </div>
    </div>
  )
}
