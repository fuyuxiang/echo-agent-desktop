// src/main/agent/tools/web.ts
import type { Tool, ToolContext, ToolResult } from './base'
import { storeGet } from '../../store'

const DEFAULT_SEARCH_ENDPOINT = 'https://duckduckgo.com/html/'
const FETCH_TIMEOUT_MS = 15_000
const MAX_FETCH_BYTES = 128 * 1024

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 合并 ctx.signal 与超时 signal */
function withTimeout(signal: AbortSignal): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)])
}

export const webFetchTool: Tool = {
  name: 'web_fetch',
  description: '抓取网页并转纯文本',
  parameters: {
    type: 'object',
    properties: { url: { type: 'string' } },
    required: ['url']
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const url = String(args.url ?? '')
    try {
      const res = await fetch(url, { signal: withTimeout(ctx.signal) })
      if (!res.ok) return { ok: false, content: `HTTP ${res.status}` }
      const html = await res.text()
      const text = htmlToText(html)
      const truncated = text.length > MAX_FETCH_BYTES
      return { ok: true, content: text.slice(0, MAX_FETCH_BYTES), truncated }
    } catch (e) {
      return { ok: false, content: `抓取失败: ${(e as Error).message}` }
    }
  }
}

interface SearchHit {
  title?: string
  url?: string
  snippet?: string
}

export const webSearchTool: Tool = {
  name: 'web_search',
  description: '公开搜索服务,返回标题/链接/摘要',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query']
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const query = String(args.query ?? '')
    const endpoint = storeGet<string>('agent.searchEndpoint') || DEFAULT_SEARCH_ENDPOINT
    const u = `${endpoint}?q=${encodeURIComponent(query)}&format=json`
    try {
      const res = await fetch(u, { signal: withTimeout(ctx.signal) })
      if (!res.ok) return { ok: false, content: `HTTP ${res.status}` }
      const data = (await res.json()) as { results?: SearchHit[] }
      const hits = data.results ?? []
      if (hits.length === 0) return { ok: true, content: '无结果' }
      const text = hits
        .map((h) => `${h.title ?? ''}\n${h.url ?? ''}\n${h.snippet ?? ''}`)
        .join('\n\n')
      return { ok: true, content: text }
    } catch (e) {
      return { ok: false, content: `搜索失败: ${(e as Error).message}` }
    }
  }
}
