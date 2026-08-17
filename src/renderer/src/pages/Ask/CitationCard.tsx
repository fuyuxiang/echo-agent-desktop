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
    // 主进程按 openUrl 协议分发:
    //   - echo://doc/<id>/page/<n>  → 跳到知识库文档查看器并定位 PDF 页;
    //   - echo://doc/<id>/t/<ms>     → 媒体查看器 seek 到时间戳;
    //   - 其余 http/https           → shell.openExternal。
    // 真实查看器后续接入;这里先确保 openExternal 路径能识别 echo:// 并触发
    // DeepLink 广播,渲染层路由 /knowledge/doc 拉原文。
    await window.api.system.openExternal(chunk.citation.openUrl)
  }

  // 文档类型标签:告诉用户"这是 PDF / 视频 / 纯文本" —— 决定后面打开方式。
  const typeLabel =
    chunk.sourceType === 'pdf' ? 'PDF'
      : chunk.sourceType === 'docx' ? 'Word'
      : chunk.sourceType === 'pptx' ? 'PPT'
      : chunk.sourceType === 'xlsx' ? '表格'
      : chunk.sourceType === 'audio' ? '音频'
      : chunk.sourceType === 'video' ? '视频'
      : chunk.sourceType === 'image' ? '图片'
      : chunk.sourceType === 'meeting' ? '会议'
      : chunk.sourceType === 'cache' ? '缓存'
      : '文档'

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
        <span className={styles.typeTag}>{typeLabel}</span>
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
