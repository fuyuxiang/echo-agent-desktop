// src/main/agent/providers/think-stream.ts
/**
 * 思考标签流式状态机。
 *
 * 背景:部分模型(MiniMax 等)不走 reasoning_content/thinking_delta 结构化字段,
 * 而是把思考过程用 <think>...</think>(或 <thinking>...)文本标签塞在正文里。
 * 必须在最早的数据边界(provider 层)归一化掉,否则:
 *   1. 标签未闭合的中间态会把 "<think>正在分析" 原样泄漏到正文;
 *   2. 标签可能被切在两个 chunk 边界("好的<thi" | "nk>"),一次性正则无法处理。
 *
 * 本状态机逐 chunk 推进,把文本切成 reasoning 段与 text 段,标签字面量永不外泄。
 */

export type ThinkPiece = { kind: 'text' | 'reasoning'; text: string }

const OPEN_TAGS = ['<think>', '<thinking>']
const CLOSE_TAGS = ['</think>', '</thinking>']
const MAX_TAG_LEN = Math.max(...[...OPEN_TAGS, ...CLOSE_TAGS].map((t) => t.length))

/** 在 buffer 中查找最早出现的任一标签,返回 {index, length};未找到返回 null */
function findTag(buffer: string, tags: string[]): { index: number; length: number } | null {
  const lower = buffer.toLowerCase()
  let best: { index: number; length: number } | null = null
  for (const tag of tags) {
    const idx = lower.indexOf(tag)
    if (idx !== -1 && (best === null || idx < best.index)) {
      best = { index: idx, length: tag.length }
    }
  }
  return best
}

/**
 * 求 buffer 末尾「可能是某个标签前缀」的最长后缀长度。
 * 用于把疑似被截断的半个标签(如末尾的 "<thi")暂存,等下个 chunk 拼齐再判定。
 */
function danglingPrefixLen(buffer: string, tags: string[]): number {
  const maxLen = Math.min(MAX_TAG_LEN - 1, buffer.length)
  for (let len = maxLen; len >= 1; len--) {
    const suffix = buffer.slice(-len).toLowerCase()
    if (tags.some((tag) => tag.startsWith(suffix))) return len
  }
  return 0
}

export class ThinkTagSplitter {
  private buffer = ''
  private mode: 'text' | 'reasoning' = 'text'

  /** 推入一段原始文本,返回本次可确定输出的若干段(标签已剥离) */
  push(text: string): ThinkPiece[] {
    this.buffer += text
    return this.drain(false)
  }

  /** 流结束时调用,把残留 buffer 按当前模式全部吐出(含未闭合标签内的内容) */
  flush(): ThinkPiece[] {
    const pieces = this.drain(true)
    if (this.buffer) {
      pieces.push({ kind: this.mode === 'reasoning' ? 'reasoning' : 'text', text: this.buffer })
      this.buffer = ''
    }
    return pieces
  }

  private drain(isFinal: boolean): ThinkPiece[] {
    const pieces: ThinkPiece[] = []
    // 合并相邻同类段,减少下游 delta 数量
    const emit = (kind: ThinkPiece['kind'], text: string): void => {
      if (!text) return
      const last = pieces[pieces.length - 1]
      if (last && last.kind === kind) last.text += text
      else pieces.push({ kind, text })
    }

    for (;;) {
      if (this.mode === 'text') {
        const hit = findTag(this.buffer, OPEN_TAGS)
        if (hit) {
          emit('text', this.buffer.slice(0, hit.index))
          this.buffer = this.buffer.slice(hit.index + hit.length)
          this.mode = 'reasoning'
          continue
        }
        // 无完整开标签:吐出确定是正文的部分,末尾疑似半个标签的后缀留到下次
        const hold = isFinal ? 0 : danglingPrefixLen(this.buffer, OPEN_TAGS)
        emit('text', this.buffer.slice(0, this.buffer.length - hold))
        this.buffer = this.buffer.slice(this.buffer.length - hold)
        break
      } else {
        const hit = findTag(this.buffer, CLOSE_TAGS)
        if (hit) {
          emit('reasoning', this.buffer.slice(0, hit.index))
          this.buffer = this.buffer.slice(hit.index + hit.length)
          this.mode = 'text'
          continue
        }
        const hold = isFinal ? 0 : danglingPrefixLen(this.buffer, CLOSE_TAGS)
        emit('reasoning', this.buffer.slice(0, this.buffer.length - hold))
        this.buffer = this.buffer.slice(this.buffer.length - hold)
        break
      }
    }
    return pieces
  }
}
