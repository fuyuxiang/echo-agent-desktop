import { logger } from '@/utils/logger'

/**
 * Ollama 客户端封装
 *
 * 全部请求经主进程受限 Ollama 桥发起，只能访问回环地址的三个固定端点。
 */

/** Ollama 默认地址(不含 /v1) */
export const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434'

export interface OllamaDetectResult {
  online: boolean
  version?: string
  error?: string
}

function normalizeBase(baseUrl: string): string {
  return (baseUrl || DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, '')
}

async function proxy(
  baseUrl: string,
  path: '/api/version' | '/api/tags' | '/api/pull',
  opts?: { method?: 'GET' | 'POST'; body?: unknown }
): Promise<{ ok: boolean; status: number; body: string }> {
  return window.api.system.ollamaRequest({ baseUrl, path, method: opts?.method, body: opts?.body })
}

/** 探测 Ollama 是否在线并返回版本(GET /api/version) */
export async function detectOllama(baseUrl: string): Promise<OllamaDetectResult> {
  const base = normalizeBase(baseUrl)
  try {
    const resp = await proxy(base, '/api/version')
    if (!resp.ok) return { online: false, error: `HTTP ${resp.status}` }
    const version = (JSON.parse(resp.body) as { version?: string }).version
    return { online: true, version }
  } catch (e) {
    return { online: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 列出本机已安装的模型名(GET /api/tags) */
export async function listOllamaModels(baseUrl: string): Promise<string[]> {
  const base = normalizeBase(baseUrl)
  const resp = await proxy(base, '/api/tags')
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  const data = JSON.parse(resp.body) as { models?: Array<{ name: string }> }
  return (data.models ?? []).map((m) => m.name)
}

/**
 * 拉取模型(POST /api/pull)。
 * 主进程一次性返回响应体，因此这里为粗粒度等待。
 * 拉取大模型耗时较长,调用方应有加载态提示。
 */
export async function pullOllamaModel(baseUrl: string, name: string): Promise<void> {
  const base = normalizeBase(baseUrl)
  const resp = await proxy(base, '/api/pull', {
    method: 'POST',
    body: { model: name, stream: false }
  })
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.body}`)
  // 非流式响应末尾应含 status: success;失败时 Ollama 返回 error 字段
  let data: { status?: string; error?: string } | null = null
  try {
    data = JSON.parse(resp.body) as { status?: string; error?: string }
  } catch (e) {
    // 仅"解析失败"容忍(只要 HTTP ok),记录日志即可
    logger.warn('[ollama] pull 响应解析异常:', e)
  }
  // error 字段是真正的拉取失败, 必须向上抛(不能被解析容错吞掉),
  // 否则调用方会误判模型已就绪
  if (data?.error) throw new Error(data.error)
}
