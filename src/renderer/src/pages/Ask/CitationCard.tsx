import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
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
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const loc = locationLabel(chunk)
  const long = chunk.text.length > 300
  const navigate = useNavigate()

  const open = async (): Promise<void> => {
    // PDF:直接跳到内置 DocViewer(hash 路由 /knowledge/doc)。
    // DocViewer 读 query 的 id / page / startMs 三个字段,这里按字段名严格对齐。
    if (chunk.sourceType === 'pdf') {
      const params = new URLSearchParams()
      params.set('id', chunk.docId)
      if (chunk.citation.page != null) params.set('page', String(chunk.citation.page))
      if (chunk.citation.startMs != null) params.set('startMs', String(chunk.citation.startMs))
      navigate(`/knowledge/doc?${params.toString()}`)
      return
    }
    // 非 PDF(Word/PPT/表格/音频/视频/图片/会议/缓存)→ 沿用 openExternal 走
    // echo://doc/... 协议,后续主进程分发;此处维持原行为占位。
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

  // L1/L2/L3 来源层级:让员工一眼看出这条引用来自个人记忆、团队还是组织层。
  // L1 由 L1/L2/L3 合并层在桌面端补;当前服务端只发 L2/L3。
  const layerLabel =
    chunk.source === 'L1' ? 'L1 个人'
      : chunk.source === 'L2' ? 'L2 团队'
      : chunk.source === 'L3' ? 'L3 组织'
      : null

  return (
    <article className={styles.card}>
      <header className={styles.cardHead}>
        <span className={styles.index}>[{index}]</span>
        <button type="button" className={styles.docLink} onClick={() => void open()}>
          {chunk.docTitle}
        </button>
        {loc && <span className={styles.loc}>{loc}</span>}
        <span className={chunk.scopeKind === 'org' ? styles.tagOrg : styles.tagTeam}>
          {chunk.scopeKind === 'org' ? t('ask.scopeOrgShort') : t('ask.scopeTeamShort')}
        </span>
        {layerLabel && <span className={styles.tagLayer}>{layerLabel}</span>}
        <span className={styles.typeTag}>{typeLabel}</span>
        {chunk.stale && <span className={styles.tagStale}>{t('citationCard.stale')}</span>}
      </header>

      {chunk.citation.heading && <div className={styles.heading}>{chunk.citation.heading}</div>}

      <div className={expanded || !long ? styles.text : styles.textClamp}>{chunk.text}</div>

      <footer className={styles.cardFoot}>
        {long && (
          <button type="button" className={styles.linkBtn} onClick={() => setExpanded(!expanded)}>
            {expanded ? t('citationCard.collapse') : t('citationCard.expand')}
          </button>
        )}
        {chunk.owner && (
          <span className={styles.owner}>
            {t('citationCard.owner', { name: chunk.owner.displayName })}
          </span>
        )}
        {onPromote && (
          <button type="button" className={styles.linkBtn} onClick={onPromote}>
            {t('citationCard.promote')}
          </button>
        )}
      </footer>
    </article>
  )
}
