/**
 * 解析 SSE 流,逐条 yield `data:` 行内容(已去前缀)。
 * 按行缓冲处理跨 chunk 拆分;遇 `[DONE]` 停止;signal abort 时停止读取。
 * 流结束时会 flush 解码器残留多字节并处理无尾换行的末行,避免丢最后一帧。
 */
export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal
): AsyncIterable<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  // 提取一行的 data 内容:非 data 行返回 null,[DONE] 返回 DONE 哨兵
  const DONE = Symbol('done')
  const parseLine = (line: string): string | typeof DONE | null => {
    const trimmed = line.trimEnd()
    if (!trimmed.startsWith('data:')) return null
    const data = trimmed.slice(5).trimStart()
    return data === '[DONE]' ? DONE : data
  }

  try {
    while (true) {
      if (signal.aborted) return
      const { done, value } = await reader.read()
      // done 时 flush 解码器残留多字节,并把 buffer 中无尾换行的末行也并入处理
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      if (done && buffer) buffer += '\n'

      let nl: number
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        const r = parseLine(line)
        if (r === DONE) return
        if (r != null) yield r
      }
      if (done) return
    }
  } finally {
    // cancel 会同时关闭底层 HTTP body 流并释放锁,避免取消/提前中断时的连接泄漏
    await reader.cancel().catch(() => {})
  }
}
