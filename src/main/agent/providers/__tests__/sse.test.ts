import { describe, it, expect } from 'vitest'
import { parseSSE } from '../sse'

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  let i = 0
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]))
      else controller.close()
    }
  })
}

async function collect(it: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = []
  for await (const x of it) out.push(x)
  return out
}

describe('parseSSE', () => {
  it('逐条提取 data 行', async () => {
    const s = streamOf(['data: a\n\n', 'data: b\n\n'])
    expect(await collect(parseSSE(s, new AbortController().signal))).toEqual(['a', 'b'])
  })

  it('处理跨 chunk 拆分的行', async () => {
    const s = streamOf(['data: hel', 'lo\n\ndata: world\n\n'])
    expect(await collect(parseSSE(s, new AbortController().signal))).toEqual(['hello', 'world'])
  })

  it('遇到 [DONE] 停止', async () => {
    const s = streamOf(['data: a\n\n', 'data: [DONE]\n\n', 'data: b\n\n'])
    expect(await collect(parseSSE(s, new AbortController().signal))).toEqual(['a'])
  })

  it('忽略非 data 行', async () => {
    const s = streamOf([': ping\n\n', 'event: foo\n', 'data: x\n\n'])
    expect(await collect(parseSSE(s, new AbortController().signal))).toEqual(['x'])
  })

  it('末行无尾换行时不丢帧', async () => {
    // 上游最后一条 data 行无尾随 \n 就结束,旧实现会丢掉它
    const s = streamOf(['data: a\n\n', 'data: last'])
    expect(await collect(parseSSE(s, new AbortController().signal))).toEqual(['a', 'last'])
  })

  it('多字节字符跨 chunk 边界切断仍能正确解码', async () => {
    const enc = new TextEncoder()
    const bytes = enc.encode('data: 你好\n\n')
    // 在 "你"(3 字节)中间切开
    const head = bytes.slice(0, 8)
    const tail = bytes.slice(8)
    const s = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(head)
        c.enqueue(tail)
        c.close()
      }
    })
    expect(await collect(parseSSE(s, new AbortController().signal))).toEqual(['你好'])
  })
})
