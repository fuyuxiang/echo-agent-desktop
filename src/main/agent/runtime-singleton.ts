// src/main/agent/runtime-singleton.ts
import { BrowserWindow } from 'electron'
import { IpcChannels } from '@shared/ipc-channels'
import { secureGet } from '../store'
import { createProvider } from './providers/factory'
import { createAgentRuntime, type AgentRuntime } from './index'
import { initMemoryManager } from './memory/singleton'
import type { RuntimeEvent } from './runtime/events'

export interface RuntimeInitConfig {
  providerId: string
  model: string
  baseUrl: string
  /** safeStorage 中 api key 的存储键 */
  apiKeyStoreKey: string
}

let instance: AgentRuntime | null = null

/** 配置就绪时装配单例: provider + runtime + 记忆门面 + 事件路由。 */
export function initAgentRuntime(cfg: RuntimeInitConfig): void {
  const apiKey = secureGet(cfg.apiKeyStoreKey) ?? ''
  const provider = createProvider({
    providerId: cfg.providerId,
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    apiKey
  })
  initMemoryManager({ provider, model: cfg.model })
  const rt = createAgentRuntime({ provider, model: cfg.model })
  rt.on((e: RuntimeEvent) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IpcChannels.agentChat.event, e)
    }
  })
  instance = rt
}

export function getAgentRuntime(): AgentRuntime | null {
  return instance
}

export function resetAgentRuntimeForTest(rt?: AgentRuntime | null): void {
  instance = rt ?? null
}
