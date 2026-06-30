// echo-agent gateway 启动后在 stdout 打印(flush)的就绪信号:
//   ECHO_AGENT_READY port=<实际端口> ws=<ws_path> health=<api_prefix>/health
// 这是 echo-agent 官方集成契约(server.py)的唯一事实源:端口(port=0 时为 OS 实际分配值)、
// WS 路径、API 前缀一次给齐。桌面端据此派生 endpoint,不再硬编码或靠 env 注入。

export interface ReadySignal {
  port: number
  wsPath: string
  apiPrefix: string
}

const RE = /ECHO_AGENT_READY\s+port=(\d+)\s+ws=(\S+)\s+health=(\S+)/

export function parseReadySignal(line: string): ReadySignal | null {
  const m = RE.exec(line)
  if (!m) return null
  const port = Number(m[1])
  if (!Number.isInteger(port) || port <= 0) return null
  const wsPath = m[2]
  // health 形如 <api_prefix>/health;去掉尾部 /health 还原 api_prefix
  const health = m[3]
  const apiPrefix = health.endsWith('/health') ? health.slice(0, -'/health'.length) : health
  return { port, wsPath, apiPrefix }
}
