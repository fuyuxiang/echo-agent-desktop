import { useAgentStore } from '@/stores/agentStore'

/**
 * 通过主进程 IPC 代理的 HTTP 请求
 * 绕过渲染进程的 CORS 限制
 */
async function proxyFetch(
  url: string,
  opts?: { method?: string; headers?: Record<string, string>; body?: string }
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const { remoteToken } = useAgentStore.getState()
  const headers: Record<string, string> = { ...opts?.headers }
  if (remoteToken) {
    headers['X-Echo-Agent-Token'] = remoteToken
  }

  const result = await window.api.system.httpProxy({
    url,
    method: opts?.method || 'GET',
    headers,
    body: opts?.body
  })

  let data: unknown
  try {
    data = JSON.parse(result.body)
  } catch {
    data = result.body
  }

  return { ok: result.ok, status: result.status, data }
}

export const agentRequest = {
  get<T>(url: string): Promise<{ data: T }> {
    return proxyFetch(url).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return { data: r.data as T }
    })
  },
  post<T>(url: string, body?: unknown): Promise<{ data: T }> {
    return proxyFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    }).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return { data: r.data as T }
    })
  },
  delete<T>(url: string): Promise<{ data: T }> {
    return proxyFetch(url, { method: 'DELETE' }).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return { data: r.data as T }
    })
  }
}
