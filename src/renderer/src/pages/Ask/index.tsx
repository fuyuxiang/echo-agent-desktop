import { useEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useOrgStore, isOrgReady, isCacheStale, type AskScope } from '@/stores/orgStore'
import { toast } from '@/components/Toast'
import type { RetrieveResult, RetrievedChunk } from '@shared/types/org'
import { CitationCard } from './CitationCard'
import { PromoteDialog } from '@/components/PromoteDialog'
import styles from './ask.module.scss'

const SCOPE_KEY: Record<AskScope, string> = {
  all: 'ask.scopeAll',
  org: 'ask.scopeOrg',
  team: 'ask.scopeTeam',
  local: 'ask.scopeLocal'
}

/**
 * 问答页 —— 员工的主入口。
 *
 * 这里刻意不做"聊天"界面:聊天已有 Chat 页。这一页解决的是"查制度"这类
 * 明确的检索需求,直接给带引用的材料,让员工自己判断,比让模型总结一段
 * 无从核实的话更可信。
 */
export function AskPage(): React.JSX.Element {
  const { t } = useTranslation()
  const status = useOrgStore((s) => s.status)
  const askScope = useOrgStore((s) => s.askScope)
  const setAskScope = useOrgStore((s) => s.setAskScope)
  const retrieve = useOrgStore((s) => s.retrieve)
  const init = useOrgStore((s) => s.init)

  const [query, setQuery] = useState('')
  const [asked, setAsked] = useState('')
  const [result, setResult] = useState<RetrieveResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [deep, setDeep] = useState(false)
  const [promoteFrom, setPromoteFrom] = useState<RetrievedChunk | null>(null)

  useEffect(() => {
    void init()
  }, [init])

  const ready = isOrgReady(status)

  const search = useCallback(
    async (q: string) => {
      const trimmed = q.trim()
      if (!trimmed) return
      setLoading(true)
      setAsked(trimmed)
      const started = Date.now()
      try {
        const res = await retrieve(trimmed, { limit: 8, multiHop: deep })
        setResult(res)
        // 回传质量数据:无答案率是服务端最值得盯的指标,少了这一步
        // 管理员就看不到知识盲区。
        void window.api.org.reportQa({
          question: trimmed,
          answered: res.chunks.length > 0 || res.memories.length > 0,
          cited_chunks: res.chunks.map((c) => c.chunkId),
          top_score: res.chunks[0]?.score,
          latency_ms: Date.now() - started,
          route: deep ? 'agentic' : 'fast'
        })
      } catch (e) {
        toast.error(t('ask.searchFailed', { message: (e as Error).message }))
      } finally {
        setLoading(false)
      }
    },
    [retrieve, deep, t]
  )

  if (!ready) {
    return (
      <div className={styles.empty}>
        <h3>{t('ask.notReadyTitle')}</h3>
        <p>
          {status?.configured ? t('ask.notReadyLoggedOut') : t('ask.notReadyNoServer')}
        </p>
      </div>
    )
  }

  const offline = status?.reachable === false
  const stale = isCacheStale(status)
  const staleCount = result?.chunks.filter((c) => c.stale).length ?? 0

  return (
    <div className={styles.page}>
      {offline && (
        <div className={styles.banner} data-tone="warn">
          {t('ask.offlineBanner', {
            lastSync: stale && status?.lastSyncAt
              ? new Date(status.lastSyncAt).toLocaleString()
              : ''
          })}
        </div>
      )}

      <div className={styles.searchBar}>
        <input
          className={styles.input}
          placeholder={t('ask.searchPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) void search(query)
          }}
        />
        <button
          type="button"
          className={styles.primary}
          disabled={loading || !query.trim()}
          onClick={() => void search(query)}
        >
          {loading ? t('ask.searching') : t('ask.search')}
        </button>
      </div>

      <div className={styles.controls}>
        <div className={styles.scopes}>
          {(Object.keys(SCOPE_KEY) as AskScope[]).map((s) => (
            <button
              key={s}
              type="button"
              className={askScope === s ? styles.chipActive : styles.chip}
              // 真实生效:在 orgStore.retrieve 里把 askScope 翻译成 scopes 过滤。
              title={t('ask.scopeOnly', { scope: t(SCOPE_KEY[s]) })}
              onClick={() => setAskScope(s)}
            >
              {t(SCOPE_KEY[s])}
              {offline && (s === 'org' || s === 'team') && (
                <span className={styles.cacheTag}>{t('ask.cacheTag')}</span>
              )}
            </button>
          ))}
        </div>
        <label className={styles.deepToggle}>
          <input type="checkbox" checked={deep} onChange={(e) => setDeep(e.target.checked)} />
          {t('ask.deep')}
          <span className={styles.hint}>{t('ask.deepHint')}</span>
        </label>
      </div>

      {result && !loading && (
        <>
          {result.memories.length > 0 && (
            <section className={styles.section}>
              <h4>{t('ask.memoriesTitle')}</h4>
              {result.memories.map((m) => (
                <div key={m.id} className={styles.memory}>
                  <span className={styles.kind}>{m.kind}</span>
                  {m.content}
                </div>
              ))}
            </section>
          )}

          {result.chunks.length === 0 ? (
            <div className={styles.noResult}>
              <p>{t('ask.noResult')}</p>
              {result.suggestAsk?.length ? (
                <p className={styles.suggest}>
                  {t('ask.suggestAsk')}
                  {result.suggestAsk.map((p) => p.displayName).join(t('common.listJoiner'))}
                </p>
              ) : (
                <p className={styles.suggest}>{t('ask.suggestOther')}</p>
              )}
            </div>
          ) : (
            <section className={styles.section}>
              <div className={styles.resultHead}>
                <h4>
                  {t('ask.resultsHead', { query: asked, count: result.chunks.length })}
                </h4>
                <span className={styles.diag}>
                  {result.diagnostics.totalMs}ms
                  {result.diagnostics.rerankSkipped && ` · ${t('ask.rerankSkipped')}`}
                  {result.fromCache && ` · ${t('ask.fromCache')}`}
                </span>
              </div>
              {/* 单条卡片各自带「可能过时」标记,但 8 条里有 3 条过时需要逐条
                  看才能发现。在顶部汇总一次,让用户先知道要留个心。 */}
              {staleCount > 0 && (
                <div className={styles.staleNote}>{t('ask.staleNote', { count: staleCount })}</div>
              )}
              {result.chunks.map((c, i) => (
                <CitationCard
                  key={c.chunkId}
                  index={i + 1}
                  chunk={c}
                  onPromote={() => setPromoteFrom(c)}
                />
              ))}
            </section>
          )}
        </>
      )}

      {promoteFrom && (
        <PromoteDialog
          source="qa"
          defaultContent=""
          evidence={[{ type: 'doc', id: promoteFrom.docId, loc: promoteFrom.docTitle }]}
          onClose={() => setPromoteFrom(null)}
        />
      )}
    </div>
  )
}

export default AskPage
