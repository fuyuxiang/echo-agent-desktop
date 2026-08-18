import { useEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useOrgStore, isOrgReady } from '@/stores/orgStore'
import type { OrgDocument, MyPromotion } from '@shared/types/org'
import styles from './org-knowledge.module.scss'

type Tab = 'docs' | 'mine'

function fmtBytes(n: number): string {
  if (!n) return '—'
  const u = ['B', 'KB', 'MB', 'GB']
  let v = n
  let i = 0
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString()
}

// 状态 → i18n key 映射(避免在 JSX 里写大段硬编码中文)
const STATE_KEY: Record<string, string> = {
  pending: 'orgKnowledge.state.pending',
  approved: 'orgKnowledge.state.approved',
  rejected: 'orgKnowledge.state.rejected',
  withdrawn: 'orgKnowledge.state.withdrawn'
}

/**
 * 组织知识浏览。
 *
 * 除了检索,员工需要能"看看库里有什么" —— 不知道有哪些文档就不知道能问
 * 什么。「我提交的」放在这里,让沉淀有反馈闭环:提了之后能看到审核结果。
 */
export function OrgKnowledgePage(): React.JSX.Element {
  const { t } = useTranslation()
  const status = useOrgStore((s) => s.status)
  const scopes = useOrgStore((s) => s.scopes)
  const init = useOrgStore((s) => s.init)
  const myPromotions = useOrgStore((s) => s.myPromotions)

  const [tab, setTab] = useState<Tab>('docs')
  const [docs, setDocs] = useState<OrgDocument[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [scopeId, setScopeId] = useState('')
  const [keyword, setKeyword] = useState('')
  const [loading, setLoading] = useState(false)
  const [mine, setMine] = useState<MyPromotion[]>([])

  useEffect(() => {
    void init()
  }, [init])

  const loadDocs = useCallback(async () => {
    setLoading(true)
    try {
      const res = await window.api.org.listDocs({
        page,
        size: 20,
        scope_id: scopeId || undefined,
        q: keyword || undefined
      })
      setDocs(res.items)
      setTotal(res.total)
    } finally {
      setLoading(false)
    }
  }, [page, scopeId, keyword])

  const loadMine = useCallback(async () => {
    setLoading(true)
    try {
      setMine(await myPromotions())
    } finally {
      setLoading(false)
    }
  }, [myPromotions])

  useEffect(() => {
    if (!isOrgReady(status)) return
    // 推迟到下一个 tick,避免 effect body 同步触发 setState 引发级联重渲染
    queueMicrotask(() => {
      if (tab === 'docs') void loadDocs()
      else void loadMine()
    })
  }, [tab, status, loadDocs, loadMine])

  if (!isOrgReady(status)) {
    return (
      <div className={styles.empty}>
        <h3>{t('orgKnowledge.notReadyTitle')}</h3>
        <p>{t('orgKnowledge.notReadyDesc')}</p>
      </div>
    )
  }

  const offline = status?.reachable === false
  const pages = Math.max(1, Math.ceil(total / 20))

  return (
    <div className={styles.page}>
      <div className={styles.tabs}>
        <button
          type="button"
          className={tab === 'docs' ? styles.tabActive : styles.tab}
          onClick={() => setTab('docs')}
        >
          {t('orgKnowledge.tabDocs')}
        </button>
        <button
          type="button"
          className={tab === 'mine' ? styles.tabActive : styles.tab}
          onClick={() => setTab('mine')}
        >
          {t('orgKnowledge.tabMine')}
        </button>
      </div>

      {tab === 'docs' ? (
        <>
          {offline && <div className={styles.banner}>{t('orgKnowledge.offlineBanner')}</div>}

          <div className={styles.filters}>
            <select
              className={styles.select}
              value={scopeId}
              onChange={(e) => {
                setScopeId(e.target.value)
                setPage(1)
              }}
            >
              <option value="">{t('orgKnowledge.scopeAll')}</option>
              {scopes.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.kind === 'org' ? t('orgKnowledge.scopeOrg') : s.name}
                </option>
              ))}
            </select>
            <input
              className={styles.search}
              placeholder={t('orgKnowledge.searchPlaceholder')}
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  setPage(1)
                  void loadDocs()
                }
              }}
            />
          </div>

          {loading ? (
            <div className={styles.loading}>{t('orgKnowledge.loading')}</div>
          ) : docs.length === 0 ? (
            <div className={styles.noResult}>{t('orgKnowledge.noDocs')}</div>
          ) : (
            <ul className={styles.list}>
              {docs.map((d) => (
                <li key={d.id} className={styles.item}>
                  <div className={styles.itemMain}>
                    <button
                      type="button"
                      className={styles.docTitle}
                      onClick={() =>
                        void window.api.system.openExternal(`echo://doc/${d.id}`)
                      }
                    >
                      {d.title}
                    </button>
                    <div className={styles.meta}>
                      <span className={d.scopeKind === 'org' ? styles.tagOrg : styles.tagTeam}>
                        {d.scopeKind === 'org' ? t('orgKnowledge.scopeOrg') : d.scopeName}
                      </span>
                      {d.sensitivity > 0 && (
                        <span className={styles.tagSec}>
                          {d.sensitivity === 1
                            ? t('orgKnowledge.sensitivityInternal')
                            : t('orgKnowledge.sensitivityConfidential')}
                        </span>
                      )}
                      <span>{d.sourceType}</span>
                      <span>{fmtBytes(d.byteSize)}</span>
                      <span>{t('orgKnowledge.chunkCount', { count: d.chunkCount })}</span>
                      {d.ownerName && (
                        <span>{t('orgKnowledge.owner', { name: d.ownerName })}</span>
                      )}
                      <span>{fmtDate(d.updatedAt)}</span>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {pages > 1 && (
            <div className={styles.pager}>
              <button
                type="button"
                className={styles.ghost}
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
              >
                {t('orgKnowledge.prev')}
              </button>
              <span className={styles.pageInfo}>
                {page} / {pages}
              </span>
              <button
                type="button"
                className={styles.ghost}
                disabled={page >= pages}
                onClick={() => setPage(page + 1)}
              >
                {t('orgKnowledge.next')}
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          {loading ? (
            <div className={styles.loading}>{t('orgKnowledge.loading')}</div>
          ) : mine.length === 0 ? (
            <div className={styles.noResult}>{t('orgKnowledge.noMine')}</div>
          ) : (
            <ul className={styles.list}>
              {mine.map((p) => {
                const payload = p.payload as { content?: string; title?: string }
                return (
                  <li key={p.id} className={styles.item}>
                    <div className={styles.itemMain}>
                      <div className={styles.mineHead}>
                        <span className={styles[`state_${p.state}`] ?? styles.state_pending}>
                          {p.local
                            ? t('orgKnowledge.localPending')
                            : t(STATE_KEY[p.state] ?? 'orgKnowledge.state.pending')}
                        </span>
                        {p.scopeName && (
                          <span className={styles.muted}>
                            →{' '}
                            {p.scopeKind === 'org'
                              ? t('orgKnowledge.scopeOrg')
                              : p.scopeName}
                          </span>
                        )}
                        <span className={styles.muted}>{fmtDate(p.createdAt)}</span>
                      </div>
                      <div className={styles.mineContent}>
                        {payload.content ?? payload.title ?? t('orgKnowledge.noContent')}
                      </div>
                      {p.reviewNote && (
                        <div className={styles.reviewNote}>
                          {t('orgKnowledge.reviewNote', { note: p.reviewNote })}
                          {p.reviewerName ? ` (${p.reviewerName})` : ''}
                        </div>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </>
      )}
    </div>
  )
}

export default OrgKnowledgePage
