import type { EchoAgentStatus } from './types'

export interface StatusBus {
  subscribe: (cb: (s: EchoAgentStatus) => void) => () => void
  emit: (s: EchoAgentStatus) => void
  last: () => EchoAgentStatus
}

/** Side-effect-free status primitive kept outside the Electron integration module. */
export function createStatusBus(): StatusBus {
  const subs = new Set<(s: EchoAgentStatus) => void>()
  let lastStatus: EchoAgentStatus = { phase: 'idle' }
  return {
    subscribe(cb) { subs.add(cb); return () => subs.delete(cb) },
    emit(s) { lastStatus = s; for (const cb of subs) cb(s) },
    last() { return lastStatus }
  }
}

export function buildWsUrl(baseUrl: string, wsPath = '/ws'): string {
  const url = new URL(wsPath, `${baseUrl.replace(/\/$/, '')}/`)
  if (url.protocol === 'http:') url.protocol = 'ws:'
  else if (url.protocol === 'https:') url.protocol = 'wss:'
  else throw new Error(`不支持的 Gateway 地址协议: ${url.protocol}`)
  return url.toString()
}
