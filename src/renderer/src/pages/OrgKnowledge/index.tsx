import { useEffect, useState, useCallback } from 'react'
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

const STATE_LABEL: Record<string, string> = {
  pending: '待审核',
  approved: '已通过',
  rejected: '已驳回',
  withdrawn: '已撤回'
}

/**
 * 组织知识浏览。
 *
 * 除了检索,员工需要能"看看库里有什么" —— 不知道有哪些文档就不知道能问
 * 什么。「我提交的」放在这里,让沉淀有反馈闭环:提了之后能看到审核结果。
 */
export function OrgKnowledgePage(): React.JSX.Element {
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
        <h3>尚未接入企业知识库</h3>
        <p>请在「设置 → 企业接入」配置服务器并登录。</p>
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
          组织文档
        </button>
        <button
          type="button"
          className={tab === 'mine' ? styles.tabActive : styles.tab}
          onClick={() => setTab('mine')}
        >
          我提交的
        </button>
      </div>

      {tab === 'docs' ? (
        <>
          {offline && (
            <div className={styles.banner}>
              服务器不可达,文档列表暂时无法加载。已缓存的内容仍可在「问答」中检索。
            </div>
          )}

          <div className={styles.filters}>
            <select
              className={styles.select}
              value={scopeId}
              onChange={(e) => {
                setScopeId(e.target.value)
                setPage(1)
              }}
            >
              <option value="">全部范围</option>
              {scopes.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.kind === 'org' ? '全公司' : s.name}
                </option>
              ))}
            </select>
            <input
              className={styles.search}
              placeholder="搜索标题"
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
            <div className={styles.loading}>加载中…</div>
          ) : docs.length === 0 ? (
            <div className={styles.noResult}>这个范围内还没有文档。</div>
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
                        {d.scopeKind === 'org' ? '全公司' : d.scopeName}
                      </span>
                      {d.sensitivity > 0 && (
                        <span className={styles.tagSec}>
                          {d.sensitivity === 1 ? '内部' : '机密'}
                        </span>
                      )}
                      <span>{d.sourceType}</span>
                      <span>{fmtBytes(d.byteSize)}</span>
                      <span>{d.chunkCount} 个片段</span>
                      {d.ownerName && <span>维护:{d.ownerName}</span>}
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
                上一页
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
                下一页
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          {loading ? (
            <div className={styles.loading}>加载中…</div>
          ) : mine.length === 0 ? (
            <div className={styles.noResult}>
              还没有提交过知识。在问答结果或会议纪要里点「沉淀为知识」即可。
            </div>
          ) : (
            <ul className={styles.list}>
              {mine.map((p) => {
                const payload = p.payload as { content?: string; title?: string }
                return (
                  <li key={p.id} className={styles.item}>
                    <div className={styles.itemMain}>
                      <div className={styles.mineHead}>
                        <span className={styles[`state_${p.state}`] ?? styles.state_pending}>
                          {p.local ? '待联网提交' : STATE_LABEL[p.state]}
                        </span>
                        {p.scopeName && (
                          <span className={styles.muted}>
                            → {p.scopeKind === 'org' ? '全公司' : p.scopeName}
                          </span>
                        )}
                        <span className={styles.muted}>{fmtDate(p.createdAt)}</span>
                      </div>
                      <div className={styles.mineContent}>
                        {payload.content ?? payload.title ?? '(无内容)'}
                      </div>
                      {p.reviewNote && (
                        <div className={styles.reviewNote}>
                          审核意见:{p.reviewNote}
                          {p.reviewerName ? `(${p.reviewerName})` : ''}
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
