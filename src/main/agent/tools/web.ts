// src/main/agent/tools/web.ts
import type { Tool, ToolContext, ToolResult } from './base'
import { storeGet } from '../../store'

const FETCH_TIMEOUT_MS = 15_000
const MAX_FETCH_BYTES = 128 * 1024

/**
 * SSRF 防护:仅放行 http/https,且拒绝指向回环/私网/链路本地地址的主机字面量。
 * 注:不做 DNS 解析,无法防御 DNS rebinding;主要拦截直接以内网地址/localhost 发起的请求。
 */
function assertSafeUrl(raw: string): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: '非法 URL' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `不支持的协议: ${url.protocol}` }
  }
  if (isBlockedHost(url.hostname)) {
    return { ok: false, reason: `拒绝访问内网/本地地址: ${url.hostname}` }
  }
  return { ok: true, url }
}

function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '') // 去 IPv6 方括号
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) {
    return true
  }
  // IPv6 回环/唯一本地/链路本地
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true
  // IPv4 字面量
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])]
    if (a === 127 || a === 0 || a === 10) return true // 回环 / 本网 / 私网 10/8
    if (a === 169 && b === 254) return true // 链路本地(含云元数据 169.254.169.254)
    if (a === 192 && b === 168) return true // 私网 192.168/16
    if (a === 172 && b >= 16 && b <= 31) return true // 私网 172.16/12
  }
  return false
}

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
    const safe = assertSafeUrl(url)
    if (!safe.ok) return { ok: false, content: safe.reason }
    try {
      const res = await fetch(safe.url, { signal: withTimeout(ctx.signal), redirect: 'follow' })
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
    // 需配置一个返回 {results:[{title,url,snippet}]} 的 JSON 搜索端点;无配置时直接告知,
    // 避免向不返回 JSON 的端点发请求后 res.json() 必然抛错的误导性失败
    const endpoint = storeGet<string>('agent.searchEndpoint')
    if (!endpoint) {
      return { ok: false, content: '未配置搜索端点(agent.searchEndpoint),无法使用 web_search' }
    }
    const u = `${endpoint}?q=${encodeURIComponent(query)}&format=json`
    const safe = assertSafeUrl(u)
    if (!safe.ok) return { ok: false, content: safe.reason }
    try {
      const res = await fetch(safe.url, { signal: withTimeout(ctx.signal), redirect: 'follow' })
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
