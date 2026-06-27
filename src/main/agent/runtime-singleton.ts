// src/main/agent/runtime-singleton.ts
import { BrowserWindow } from 'electron'
import { IpcChannels } from '@shared/ipc-channels'
import { secureGet } from '../store'
import { createProvider } from './providers/factory'
import { createAgentRuntime, type AgentRuntime } from './index'
import { initMemoryManager } from './memory/singleton'
import type { RuntimeEvent } from './runtime/events'
import type { ChatProvider } from './providers/types'
import { sanitizeTitle } from './title'

export interface RuntimeInitConfig {
  providerId: string
  model: string
  baseUrl: string
  /** safeStorage 中 api key 的存储键 */
  apiKeyStoreKey: string
}

let instance: AgentRuntime | null = null
/** 标题生成等轻量补全场景复用同一 provider/model,无需再走完整 agent 循环 */
let activeProvider: ChatProvider | null = null
let activeModel = ''

/** 配置就绪时装配单例: provider + runtime + 记忆门面 + 事件路由。 */
export function initAgentRuntime(cfg: RuntimeInitConfig): void {
  // 重入:先释放旧实例(中止在途会话 + 注销其事件 handler),避免孤立实例继续向窗口广播
  instance?.dispose()
  const apiKey = secureGet(cfg.apiKeyStoreKey) ?? ''
  if (!apiKey) {
    console.warn('[runtime-singleton] API Key 为空,provider 调用可能失败')
  }
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
  activeProvider = provider
  activeModel = cfg.model
}

export function getAgentRuntime(): AgentRuntime | null {
  return instance
}

/**
 * 用一次轻量、非流式的补全为会话生成简短标题(参考豆包/ChatGPT:4-12 字的主题概括,无省略号)。
 * 复用已装配的 provider/model,不走完整 agent 循环(无工具、无记忆、不广播事件)。
 * 失败或未装配时返回空串,调用方自行回退到截断方案。
 */
export async function generateTitle(firstUserMessage: string): Promise<string> {
  if (!activeProvider || !firstUserMessage.trim()) return ''
  const signal = AbortSignal.timeout(8000)
  const prompt = [
    '你是会话标题生成器。根据用户的第一条消息,生成一个简短的中文标题概括对话主题。',
    '要求:',
    '1. 4 到 12 个汉字,不要超过 15 字。',
    '2. 只输出标题本身,不要引号、标点、解释或前后缀。',
    '3. 概括主题,而非复述原文。',
    '',
    `用户消息:${firstUserMessage.slice(0, 500)}`
  ].join('\n')

  try {
    let out = ''
    for await (const delta of activeProvider.chat(
      {
        model: activeModel,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        maxTokens: 40
      },
      signal
    )) {
      if (delta.type === 'text') out += delta.text
      else if (delta.type === 'error') return ''
    }
    return sanitizeTitle(out)
  } catch {
    return ''
  }
}

export function resetAgentRuntimeForTest(rt?: AgentRuntime | null): void {
  instance = rt ?? null
}
