import { ipcMain } from 'electron'
import { IpcChannels } from '@shared/ipc-channels'
import {
  getEchoAgentStatus,
  getEchoAgentVersion,
  getEchoAgentEndpoint,
  onEchoAgentStatus,
  updateEchoAgent,
  applyModelConfig
} from '../echo-agent'
import type { ModelConfigInput } from '../echo-agent/config-writer'
import { gatewayAdminToken } from '../echo-agent/security-tokens'

type ManagementRequest = {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
  body?: unknown
  file?: { name: string; mimeType: string; data: Uint8Array }
}

const MANAGEMENT_RULES: Array<{ prefix: string; methods: Set<ManagementRequest['method']> }> = [
  { prefix: '/memory', methods: new Set(['GET', 'POST', 'PUT', 'DELETE']) },
  { prefix: '/skills', methods: new Set(['GET', 'POST', 'DELETE']) },
  { prefix: '/channels', methods: new Set(['GET']) },
  { prefix: '/knowledge', methods: new Set(['GET', 'POST', 'DELETE']) },
  { prefix: '/tasks', methods: new Set(['GET', 'POST', 'PUT', 'DELETE']) },
  { prefix: '/cron', methods: new Set(['GET', 'POST', 'PUT', 'DELETE']) },
  { prefix: '/chat/attachments', methods: new Set(['POST']) }
]

async function managementRequest(request: ManagementRequest): Promise<unknown> {
  const endpoint = getEchoAgentEndpoint()
  if (!endpoint) throw new Error('Agent 尚未就绪')
  if (!request || !['GET', 'POST', 'PUT', 'DELETE'].includes(request.method)) {
    throw new Error('不支持的 Agent 管理请求')
  }
  const relative = new URL(request.path, 'http://echo.local')
  if (!request.path.startsWith('/') || relative.origin !== 'http://echo.local') {
    throw new Error('Agent 管理路径无效')
  }
  const rule = MANAGEMENT_RULES.find(
    (r) => relative.pathname === r.prefix || relative.pathname.startsWith(`${r.prefix}/`)
  )
  if (!rule || !rule.methods.has(request.method)) throw new Error('Agent 管理路径未获授权')

  const headers = new Headers({ authorization: `Bearer ${gatewayAdminToken}` })
  let body: string | FormData | undefined
  if (request.file) {
    if (request.file.data.byteLength > 100 * 1024 * 1024) throw new Error('文件不能超过 100MB')
    const form = new FormData()
    const bytes = new Uint8Array(request.file.data.byteLength)
    bytes.set(request.file.data)
    form.append(
      'file',
      new Blob([bytes.buffer], { type: request.file.mimeType || 'application/octet-stream' }),
      request.file.name
    )
    body = form
  } else if (request.body !== undefined) {
    headers.set('content-type', 'application/json')
    body = JSON.stringify(request.body)
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 120_000)
  try {
    const url = `${endpoint.baseUrl}${endpoint.apiPrefix}${relative.pathname}${relative.search}`
    const response = await fetch(url, { method: request.method, headers, body, signal: ctrl.signal })
    const contentType = response.headers.get('content-type') ?? ''
    const payload: unknown = contentType.includes('application/json')
      ? await response.json()
      : await response.text()
    if (!response.ok) {
      const message =
        payload && typeof payload === 'object' && 'error' in payload
          ? String((payload as { error: unknown }).error)
          : `Agent 请求失败 HTTP ${response.status}`
      throw new Error(message)
    }
    return payload
  } finally {
    clearTimeout(timer)
  }
}

export function registerEchoAgentIpc(getWindow: () => Electron.BrowserWindow | null): void {
  ipcMain.handle(IpcChannels.echoAgent.getStatus, () => getEchoAgentStatus())
  ipcMain.handle(IpcChannels.echoAgent.getVersion, () => getEchoAgentVersion())
  ipcMain.handle(IpcChannels.echoAgent.update, () => updateEchoAgent())
  ipcMain.handle(IpcChannels.echoAgent.getEndpoint, () => getEchoAgentEndpoint())
  ipcMain.handle(IpcChannels.echoAgent.managementRequest, (_e, request: ManagementRequest) =>
    managementRequest(request)
  )
  ipcMain.handle(IpcChannels.echoConfig.apply, (_e, cfg: ModelConfigInput) => applyModelConfig(cfg))

  onEchoAgentStatus((status) => {
    getWindow()?.webContents.send(IpcChannels.echoAgent.statusChanged, status)
  })
}
