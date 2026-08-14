import log from 'electron-log/main'
import type { ChatProvider } from '../agent/providers/types'
import type { SegmentDTO } from '@shared/types/meeting'
import type { MemoryKind, KnowledgeCandidate } from '@shared/types/org'
import { getLLMProvider, getLLMConfig } from '../echo-agent/llm'

/**
 * 会议候选知识抽取。
 *
 * 与会议纪要(meeting-summary.ts)的区别:纪要是给人读的散文,候选知识是要
 * 进组织库的结构化条目 —— 必须带类型、带依据、带时间戳锚点,否则审核人
 * 无从判断,后来人也无法回溯"这话是谁在什么时候说的"。
 *
 * 这是"知识从日常工作自动沉淀"的落点:开完会顺手勾几条,比事后专门整理
 * 文档的转化率高一个量级。
 */

export type { KnowledgeCandidate }

// 只抽这三类。待办事项归 actionItems(纪要已有),不进组织知识 ——
// "张三下周三前提交报表"是任务而非知识,进了库就成了永久噪音。
const KINDS: MemoryKind[] = ['decision', 'convention', 'pitfall']

export function buildCandidatePrompt(segments: SegmentDTO[]): string {
  const transcript = segments
    .map((s) => {
      const ts = Math.floor(s.startMs / 1000)
      const mm = String(Math.floor(ts / 60)).padStart(2, '0')
      const ss = String(ts % 60).padStart(2, '0')
      return `[${mm}:${ss}]${s.speaker ? `[${s.speaker}]` : ''} ${s.text}`
    })
    .join('\n')

  return [
    '从以下会议转写中,抽取值得长期留存到公司知识库的条目。',
    '',
    '只抽三类:',
    '- decision:会上定下来的事(如"采购统一走线上流程")',
    '- convention:形成的做法或约定(如"周报周五下班前提交")',
    '- pitfall:踩过的坑与教训(如"批量导入前必须先备份,上次丢了数据")',
    '',
    '不要抽取:',
    '- 具体待办(某人某时做某事)—— 那是任务,不是知识',
    '- 只在本次会议内有效的信息(如"我们先看第二页")',
    '- 讨论中未形成结论的分歧',
    '',
    '严格输出 JSON 数组,不要 Markdown 代码块,不要额外解释。每项字段:',
    '{"kind":"decision|convention|pitfall","content":"一句话陈述,不超过200字",',
    '"rationale":"为什么成立,一句话","quote":"支撑该条的原文片段,照抄",',
    '"timestamp":"MM:SS 该内容对应的时间点"}',
    '',
    '若没有值得留存的内容,输出 []。宁缺勿滥 —— 低质条目进了知识库会污染后续问答。',
    '',
    '会议转写:',
    transcript
  ].join('\n')
}

/** "MM:SS" -> 毫秒。解析失败返回 null,不猜。 */
export function parseTimestamp(ts: unknown): number | null {
  if (typeof ts !== 'string') return null
  const m = /^(\d{1,3}):(\d{2})$/.exec(ts.trim())
  if (!m) return null
  return (Number(m[1]) * 60 + Number(m[2])) * 1000
}

/**
 * 解析模型输出。
 *
 * 模型时常无视"不要代码块"的要求,所以要剥掉 ```json 包裹;也可能在数组
 * 前后带一句解释,故用首尾括号定位。解析失败返回空数组而非抛错 ——
 * 抽取失败只该让候选区为空,不能让整个会议详情页崩掉。
 */
export function parseCandidates(
  raw: string,
  segments: SegmentDTO[]
): KnowledgeCandidate[] {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return []

  let arr: unknown
  try {
    arr = JSON.parse(text.slice(start, end + 1))
  } catch {
    log.warn('[meeting-candidates] JSON 解析失败')
    return []
  }
  if (!Array.isArray(arr)) return []

  const out: KnowledgeCandidate[] = []
  arr.forEach((item, i) => {
    if (typeof item !== 'object' || item === null) return
    const o = item as Record<string, unknown>
    const kind = String(o.kind ?? '') as MemoryKind
    const content = String(o.content ?? '').trim()
    // 类型不在白名单或内容为空的条目直接丢弃:让模型的自由发挥进组织库
    // 才是真正的风险。
    if (!KINDS.includes(kind) || !content) return

    const startMs = parseTimestamp(o.timestamp)
    const quote = String(o.quote ?? '').trim()
    out.push({
      id: `cand-${i}`,
      kind,
      content: content.slice(0, 2000),
      rationale: String(o.rationale ?? '').trim().slice(0, 2000),
      quote: quote.slice(0, 500),
      startMs,
      speaker: findSpeaker(segments, startMs, quote)
    })
  })
  return out
}

/** 按时间戳或原文反查发言人,让候选带上"谁说的"。 */
function findSpeaker(
  segments: SegmentDTO[],
  startMs: number | null,
  quote: string
): string | null {
  if (startMs != null) {
    const hit = segments.find((s) => s.startMs <= startMs && startMs <= s.endMs)
    if (hit?.speaker) return hit.speaker
  }
  if (quote) {
    const key = quote.slice(0, 12)
    const hit = segments.find((s) => s.text.includes(key))
    if (hit?.speaker) return hit.speaker
  }
  return null
}

export async function extractCandidates(
  segments: SegmentDTO[],
  deps?: { provider?: ChatProvider }
): Promise<KnowledgeCandidate[]> {
  if (segments.length === 0) return []
  const provider = deps?.provider ?? getLLMProvider()
  if (!provider) return []

  const signal = AbortSignal.timeout(120_000)
  try {
    let out = ''
    for await (const delta of provider.chat(
      {
        model: getLLMConfig()?.model ?? '',
        messages: [{ role: 'user', content: buildCandidatePrompt(segments) }],
        // 低温:抽取是提取而非创作,发挥空间越小越好
        temperature: 0.1
      },
      signal
    )) {
      if (delta.type === 'text') out += delta.text
      else if (delta.type === 'error') {
        log.warn('[meeting-candidates] 抽取失败(provider error):', delta.message)
        return []
      }
    }
    return parseCandidates(out, segments)
  } catch (e) {
    log.warn('[meeting-candidates] 抽取失败:', e)
    return []
  }
}
