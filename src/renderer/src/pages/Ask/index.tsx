import { useEffect, useState, useCallback } from 'react'
import { useOrgStore, isOrgReady, isCacheStale, type AskScope } from '@/stores/orgStore'
import { toast } from '@/components/Toast'
import type { RetrieveResult, RetrievedChunk } from '@shared/types/org'
import { CitationCard } from './CitationCard'
import { PromoteDialog } from '@/components/PromoteDialog'
import styles from './ask.module.scss'

const SCOPE_LABEL: Record<AskScope, string> = {
  all: '全部',
  org: '组织库',
  team: '我的团队',
  local: '仅本机'
}

/**
 * 问答页 —— 员工的主入口。
 *
 * 这里刻意不做"聊天"界面:聊天已有 Chat 页。这一页解决的是"查制度"这类
 * 明确的检索需求,直接给带引用的材料,让员工自己判断,比让模型总结一段
 * 无从核实的话更可信。
 */
export function AskPage(): React.JSX.Element {
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
          citedChunks: res.chunks.map((c) => c.chunkId),
          topScore: res.chunks[0]?.score,
          latencyMs: Date.now() - started,
          route: deep ? 'agentic' : 'fast'
        })
      } catch (e) {
        toast.error(`检索失败:${(e as Error).message}`)
      } finally {
        setLoading(false)
      }
    },
    [retrieve, deep]
  )

  if (!ready) {
    return (
      <div className={styles.empty}>
        <h3>尚未接入企业知识库</h3>
        <p>
          {status?.configured
            ? '请在「设置 → 企业接入」登录后使用组织知识问答。'
            : '请在「设置 → 企业接入」填写企业服务器地址并登录。'}
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
          离线模式:服务器不可达,以下结果来自本地缓存
          {stale && status?.lastSyncAt
            ? `(最后同步于 ${new Date(status.lastSyncAt).toLocaleString()})`
            : ''}
          ,可能不是最新。
        </div>
      )}

      <div className={styles.searchBar}>
        <input
          className={styles.input}
          placeholder="问一个问题,如:差旅住宿标准是多少"
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
          {loading ? '检索中…' : '检索'}
        </button>
      </div>

      <div className={styles.controls}>
        <div className={styles.scopes}>
          {(Object.keys(SCOPE_LABEL) as AskScope[]).map((s) => (
            <button
              key={s}
              type="button"
              className={askScope === s ? styles.chipActive : styles.chip}
              // 真实生效:在 orgStore.retrieve 里把 askScope 翻译成 scopes 过滤。
              title={`仅检索${SCOPE_LABEL[s]}`}
              onClick={() => setAskScope(s)}
            >
              {SCOPE_LABEL[s]}
              {offline && (s === 'org' || s === 'team') && <span className={styles.cacheTag}>缓存</span>}
            </button>
          ))}
        </div>
        <label className={styles.deepToggle}>
          <input type="checkbox" checked={deep} onChange={(e) => setDeep(e.target.checked)} />
          深度检索
          <span className={styles.hint}>用于对比、汇总类问题,更慢但更全</span>
        </label>
      </div>

      {result && !loading && (
        <>
          {result.memories.length > 0 && (
            <section className={styles.section}>
              <h4>已确认的组织约定</h4>
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
              <p>没有找到相关内容。</p>
              {result.suggestAsk?.length ? (
                <p className={styles.suggest}>
                  这个问题可能需要问:
                  {result.suggestAsk.map((p) => p.displayName).join('、')}
                </p>
              ) : (
                <p className={styles.suggest}>
                  可以试着换个说法,或联系管理员补充相关文档。
                </p>
              )}
            </div>
          ) : (
            <section className={styles.section}>
              <div className={styles.resultHead}>
                <h4>
                  「{asked}」找到 {result.chunks.length} 条材料
                </h4>
                <span className={styles.diag}>
                  {result.diagnostics.totalMs}ms
                  {result.diagnostics.rerankSkipped && ' · 精排降级'}
                  {result.fromCache && ' · 本地缓存'}
                </span>
              </div>
              {/* 单条卡片各自带「可能过时」标记,但 8 条里有 3 条过时需要逐条
                  看才能发现。在顶部汇总一次,让用户先知道要留个心。 */}
              {staleCount > 0 && (
                <div className={styles.staleNote}>
                  其中 {staleCount} 条来自时效性内容且已超过 90 天未更新,建议与维护人核实后再依据它做决定。
                </div>
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
