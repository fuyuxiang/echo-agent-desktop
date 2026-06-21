import { logger } from '@/utils/logger'

/**
 * Ollama 客户端封装
 *
 * 全部请求经主进程 httpProxy 发起(绕过 CORS),直连本机 Ollama 原生 API。
 * 注意:不复用 agent/proxy-request(那会注入 X-Echo-Agent-Token),Ollama 不需要该 token。
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
  url: string,
  opts?: { method?: string; body?: string }
): Promise<{ ok: boolean; status: number; body: string }> {
  return window.api.agent.httpProxy({
    url,
    method: opts?.method ?? 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts?.body
  })
}

/** 探测 Ollama 是否在线并返回版本(GET /api/version) */
export async function detectOllama(baseUrl: string): Promise<OllamaDetectResult> {
  const base = normalizeBase(baseUrl)
  try {
    const resp = await proxy(`${base}/api/version`)
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
  const resp = await proxy(`${base}/api/tags`)
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  const data = JSON.parse(resp.body) as { models?: Array<{ name: string }> }
  return (data.models ?? []).map((m) => m.name)
}

/**
 * 拉取模型(POST /api/pull)。
 * httpProxy 一次性返回响应体,不支持流式增量,因此这里为粗粒度等待:成功 resolve,失败 reject。
 * 拉取大模型耗时较长,调用方应有加载态提示。
 */
export async function pullOllamaModel(baseUrl: string, name: string): Promise<void> {
  const base = normalizeBase(baseUrl)
  const resp = await proxy(`${base}/api/pull`, {
    method: 'POST',
    body: JSON.stringify({ model: name, stream: false })
  })
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.body}`)
  // 非流式响应末尾应含 status: success;失败时 Ollama 返回 error 字段
  try {
    const data = JSON.parse(resp.body) as { status?: string; error?: string }
    if (data.error) throw new Error(data.error)
  } catch (e) {
    // 解析失败不视为致命(只要 HTTP ok),记录日志即可
    logger.warn('[ollama] pull 响应解析异常:', e)
  }
}
