import { useState } from 'react'
import type { RetrievedChunk } from '@shared/types/org'
import styles from './ask.module.scss'

/** 音视频引用定位到秒,让"第 12 分钟说的"能直接跳过去。 */
function fmtTimestamp(ms: number): string {
  const total = Math.floor(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function locationLabel(chunk: RetrievedChunk): string {
  const { page, startMs } = chunk.citation
  if (page != null) return `第 ${page} 页`
  if (startMs != null) return fmtTimestamp(startMs)
  return ''
}

/**
 * 引用卡片。
 *
 * 溯源是这套系统可信度的关键:员工能点开原文自己核对,而不是被迫相信一段
 * 无从验证的总结。所以位置信息(页码、时间戳、标题链)要一路从服务端带到
 * 这里,任何一环丢了都会让引用退化成"某个文档里说过"。
 */
export function CitationCard({
  index,
  chunk,
  onPromote
}: {
  index: number
  chunk: RetrievedChunk
  onPromote?: () => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const loc = locationLabel(chunk)
  const long = chunk.text.length > 300

  const open = async (): Promise<void> => {
    // 主进程按 openUrl 决定用哪种查看器(PDF 定位到页、媒体 seek 到秒)。
    await window.api.system.openExternal(chunk.citation.openUrl)
  }

  return (
    <article className={styles.card}>
      <header className={styles.cardHead}>
        <span className={styles.index}>[{index}]</span>
        <button type="button" className={styles.docLink} onClick={() => void open()}>
          {chunk.docTitle}
        </button>
        {loc && <span className={styles.loc}>{loc}</span>}
        <span className={chunk.scopeKind === 'org' ? styles.tagOrg : styles.tagTeam}>
          {chunk.scopeKind === 'org' ? '全公司' : '团队'}
        </span>
        {chunk.stale && <span className={styles.tagStale}>可能过时</span>}
      </header>

      {chunk.citation.heading && <div className={styles.heading}>{chunk.citation.heading}</div>}

      <div className={expanded || !long ? styles.text : styles.textClamp}>{chunk.text}</div>

      <footer className={styles.cardFoot}>
        {long && (
          <button type="button" className={styles.linkBtn} onClick={() => setExpanded(!expanded)}>
            {expanded ? '收起' : '展开全文'}
          </button>
        )}
        {chunk.owner && <span className={styles.owner}>维护人:{chunk.owner.displayName}</span>}
        {onPromote && (
          <button type="button" className={styles.linkBtn} onClick={onPromote}>
            沉淀为知识
          </button>
        )}
      </footer>
    </article>
  )
}
