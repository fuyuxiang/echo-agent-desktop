/**
 * 解析 SSE 流,逐条 yield `data:` 行内容(已去前缀)。
 * 按行缓冲处理跨 chunk 拆分;遇 `[DONE]` 停止;signal abort 时停止读取。
 */
export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal
): AsyncIterable<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      if (signal.aborted) return
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trimEnd()
        buffer = buffer.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trimStart()
        if (data === '[DONE]') return
        yield data
      }
    }
  } finally {
    reader.releaseLock()
  }
}
