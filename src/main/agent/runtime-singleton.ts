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
  console.log('[runtime-singleton] 开始初始化 runtime, config=', {
    providerId: cfg.providerId,
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    apiKeyStoreKey: cfg.apiKeyStoreKey
  })
  // 重入:先释放旧实例(中止在途会话 + 注销其事件 handler),避免孤立实例继续向窗口广播
  instance?.dispose()
  const apiKey = secureGet(cfg.apiKeyStoreKey) ?? ''
  console.log('[runtime-singleton] API Key 长度:', apiKey.length)
  if (!apiKey) {
    console.warn('[runtime-singleton] API Key 为空,provider 调用可能失败')
  }
  const provider = createProvider({
    providerId: cfg.providerId,
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    apiKey
  })
  console.log('[runtime-singleton] Provider 创建成功')
  initMemoryManager({ provider, model: cfg.model })
  const rt = createAgentRuntime({ provider, model: cfg.model })
  rt.on((e: RuntimeEvent) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IpcChannels.agentChat.event, e)
    }
  })
  instance = rt
  console.log('[runtime-singleton] Runtime 初始化完成')
}

export function getAgentRuntime(): AgentRuntime | null {
  return instance
}

export function resetAgentRuntimeForTest(rt?: AgentRuntime | null): void {
  instance = rt ?? null
}
