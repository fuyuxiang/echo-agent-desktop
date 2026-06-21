import { ipcMain, BrowserWindow } from 'electron'
import { IpcChannels } from '@shared/ipc-channels'
import * as pythonEnv from '../agent-process/python-env'
import * as agentManager from '../agent-process/manager'
import { generateAgentConfig } from '../agent-process/config-gen'
import { LOGS_DIR } from '../agent-process/constants'
import { secureGet } from '../store'
import type { AgentConfig, InstallProgressEvent } from '@shared/types'
import fs from 'fs'
import path from 'path'

export function registerAgentIpcHandlers(): void {
  ipcMain.handle(IpcChannels.agent.getEnvInfo, () => pythonEnv.getEnvInfo())

  ipcMain.handle(IpcChannels.agent.getStatus, () => agentManager.getStatus())

  ipcMain.handle(IpcChannels.agent.getPort, () => agentManager.getPort())

  ipcMain.handle(IpcChannels.agent.start, async () => {
    const keys = getApiKeysFromSecureStore()
    return agentManager.startAgent(keys)
  })

  ipcMain.handle(IpcChannels.agent.stop, () => agentManager.stopAgent())

  ipcMain.handle(IpcChannels.agent.restart, async () => {
    const keys = getApiKeysFromSecureStore()
    return agentManager.restartAgent(keys)
  })

  ipcMain.handle(IpcChannels.agent.initEnv, async (_event, pipIndex?: string) => {
    const win = BrowserWindow.getFocusedWindow()
    const onProgress = (event: InstallProgressEvent): void => {
      win?.webContents.send(IpcChannels.agent.onInstallProgress, event)
    }
    try {
      await pythonEnv.initializeEnvironment(onProgress, pipIndex)
      return { success: true }
    } catch (e) {
      return { success: false, error: (e as Error).message }
    }
  })

  ipcMain.handle(IpcChannels.agent.upgrade, async (_event, pipIndex?: string) => {
    try {
      const version = await pythonEnv.upgradeEchoAgent(pipIndex)
      return { success: true, version }
    } catch (e) {
      return { success: false, error: (e as Error).message }
    }
  })

  ipcMain.handle(IpcChannels.agent.resetEnv, async (_event, pipIndex?: string) => {
    const win = BrowserWindow.getFocusedWindow()
    const onProgress = (event: InstallProgressEvent): void => {
      win?.webContents.send(IpcChannels.agent.onInstallProgress, event)
    }
    try {
      await pythonEnv.resetEnvironment(onProgress, pipIndex)
      return { success: true }
    } catch (e) {
      return { success: false, error: (e as Error).message }
    }
  })

  ipcMain.handle(IpcChannels.agent.updateConfig, (_event, config: AgentConfig) => {
    generateAgentConfig(config)
    return { success: true }
  })

  ipcMain.handle(IpcChannels.agent.getLogs, () => {
    try {
      const logFile = path.join(LOGS_DIR, 'agent.log')
      if (!fs.existsSync(logFile)) return ''
      const content = fs.readFileSync(logFile, 'utf-8')
      const lines = content.split('\n')
      return lines.slice(-200).join('\n')
    } catch {
      return ''
    }
  })

  // 状态变化通知渲染层
  agentManager.onStatusChange((status) => {
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send(IpcChannels.agent.onStatusChanged, status)
    })
  })

  // HTTP 代理：渲染进程通过主进程发起请求，绕过 CORS
  // 安全防护: 仅允许 http/https; 拒绝带嵌入凭据的 URL; 支持超时中断(默认 30s)。
  ipcMain.handle(
    IpcChannels.agent.httpProxy,
    async (
      _event,
      opts: {
        url: string
        method?: string
        headers?: Record<string, string>
        body?: string
        timeoutMs?: number
      }
    ) => {
      let parsed: URL
      try {
        parsed = new URL(opts.url)
      } catch {
        return { ok: false, status: 0, body: `非法 URL: ${opts.url}` }
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, status: 0, body: `不支持的协议: ${parsed.protocol}` }
      }
      if (parsed.username || parsed.password) {
        return { ok: false, status: 0, body: 'URL 不允许包含嵌入凭据' }
      }

      const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 30_000
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const { net } = await import('electron')
        const resp = await net.fetch(parsed.toString(), {
          method: opts.method || 'GET',
          headers: opts.headers,
          body: opts.body,
          signal: controller.signal
        })
        const text = await resp.text()
        return { ok: resp.ok, status: resp.status, body: text }
      } catch (e) {
        const aborted = controller.signal.aborted
        return {
          ok: false,
          status: 0,
          body: aborted ? `请求超时(${timeoutMs}ms)` : (e as Error).message
        }
      } finally {
        clearTimeout(timer)
      }
    }
  )
}

function getApiKeysFromSecureStore(): Record<string, string> {
  const keys: Record<string, string> = {}
  const openaiKey = secureGet('openai-api-key')
  const anthropicKey = secureGet('anthropic-api-key')
  const geminiKey = secureGet('gemini-api-key')
  const openrouterKey = secureGet('openrouter-api-key')

  if (openaiKey) keys.OPENAI_API_KEY = openaiKey
  if (anthropicKey) keys.ANTHROPIC_API_KEY = anthropicKey
  if (geminiKey) keys.GOOGLE_API_KEY = geminiKey
  if (openrouterKey) keys.OPENROUTER_API_KEY = openrouterKey

  return keys
}
