/**
 * 本地 echo-agent Gateway 的 HTTP 门面
 *
 * - 本地 Gateway 运行在 127.0.0.1:<动态端口>,渲染层经主进程 `agent.httpProxy` 调用以绕过 CORS
 * - 页面/服务层统一通过此门面访问,不直接使用 window.api(符合 PAGE_GUIDE)
 */
export async function agentHttp<T>(
  path: string,
  init?: { method?: string; body?: unknown }
): Promise<T> {
  const port = await window.api.agent.getPort()
  if (!port) throw new Error('本地 Agent 未运行')

  const res = await window.api.agent.httpProxy({
    url: `http://127.0.0.1:${port}${path}`,
    method: init?.method ?? 'GET',
    headers: { 'content-type': 'application/json' },
    body: init?.body ? JSON.stringify(init.body) : undefined
  })

  if (!res.ok) throw new Error(`本地 Agent 请求失败: HTTP ${res.status}`)

  return JSON.parse(res.body) as T
}
