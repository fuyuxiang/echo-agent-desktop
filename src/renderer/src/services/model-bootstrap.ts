import { fetchModelConfig, type ModelConfigDTO } from './server'
import { storage } from '@/utils'
import {
  LOCAL_OLLAMA_CONFIG_KEY,
  toOllamaOpenAIBase,
  type LocalOllamaConfig
} from './model-config'
import { logger } from '@/utils/logger'
import { useAgentStore } from '@/stores/agentStore'
import { useUserStore } from '@/stores/userStore'

/** providerId -> safeStorage api key 名映射(沿用旧 key 名) */
function apiKeyStoreKey(providerId: string): string {
  const map: Record<string, string> = {
    openai: 'openai-api-key',
    anthropic: 'anthropic-api-key',
    gemini: 'gemini-api-key',
    openrouter: 'openrouter-api-key',
    deepseek: 'deepseek-api-key'
  }
  return map[providerId] ?? `${providerId}-api-key`
}

/**
 * 方案A: 登录后从服务器拉取模型配置,装配到主进程原生 AgentRuntime。
 *
 * 流程:拿 { providerId, model, baseUrl } -> 主进程用 safeStorage 取 apiKey -> createProvider -> createAgentRuntime。
 * 渲染层永不接触 apiKey。
 *
 * 返回:
 * - configured:runtime 是否真正装配成功(init 调通)。false 表示发送会失败
 * - retryable:本次未装配是否为暂时性原因(网络/超时),true 时上层可在网络恢复后重试
 */
export async function applyServerModelConfigAndStart(): Promise<{
  ok: boolean
  configured: boolean
  retryable: boolean
  error?: string
}> {
  const agent = useAgentStore.getState()
  const LOCAL_CONFIG_KEY = 'modelConfig.local'

  try {
    // ① Ollama 本地模型(显式启用,最高优先)
    const localModel = await storage.get<LocalOllamaConfig>(LOCAL_OLLAMA_CONFIG_KEY)
    if (localModel?.enabled && localModel.baseUrl && localModel.modelName) {
      await window.api.agentChat.init({
        providerId: 'openai',
        model: localModel.modelName,
        baseUrl: toOllamaOpenAIBase(localModel.baseUrl),
        apiKeyStoreKey: apiKeyStoreKey('ollama')
      })
      agent.setReady(true)
      agent.setConfigured(true)
      logger.info('[model-bootstrap] Ollama 本地模型已装配')
      return { ok: true, configured: true, retryable: false }
    }

    // ② 已登录:优先从服务器拉取配置
    let serverFetchFailed = false
    if (useUserStore.getState().isAuthed) {
      let cfg: ModelConfigDTO | null = null
      try {
        cfg = await fetchModelConfig()
      } catch (e) {
        serverFetchFailed = true
        logger.warn('[model-bootstrap] 服务器配置拉取失败,尝试本地兜底:', e)
      }

      if (cfg?.baseUrl && cfg?.modelName) {
        const providerId = 'openai'
        const storeKey = apiKeyStoreKey(providerId)
        if (cfg.apiKey) {
          await storage.secure.set(storeKey, cfg.apiKey)
        }
        await window.api.agentChat.init({
          providerId,
          model: cfg.modelName,
          baseUrl: cfg.baseUrl,
          apiKeyStoreKey: storeKey
        })
        agent.setReady(true)
        agent.setConfigured(true)
        logger.info(`[model-bootstrap] 服务器配置已装配 model=${cfg.modelName}`)
        return { ok: true, configured: true, retryable: false }
      }
      // 服务器无有效配置,fall through 到本地手动配置
    }

    // ③ 本地手动配置(未登录的唯一来源 / 已登录但服务器未配置的兜底)
    const localCfg = await storage.get<{ baseUrl: string; modelName: string }>(LOCAL_CONFIG_KEY)
    if (localCfg?.baseUrl && localCfg?.modelName) {
      const storeKey = 'openai-api-key'
      await window.api.agentChat.init({
        providerId: 'openai',
        model: localCfg.modelName,
        baseUrl: localCfg.baseUrl,
        apiKeyStoreKey: storeKey
      })
      agent.setReady(true)
      agent.setConfigured(true)
      logger.info(`[model-bootstrap] 本地手动配置已装配 model=${localCfg.modelName}`)
      return { ok: true, configured: true, retryable: false }
    }

    // ④ 无任何可用配置:UI 就绪但 runtime 未装配,用户需去设置页配置
    agent.setReady(true)
    const isAuthed = useUserStore.getState().isAuthed
    if (serverFetchFailed) {
      // 已登录但服务器配置拉取因网络/超时失败,且无本地兜底:标记可重试,网络恢复后自愈重装配
      logger.info('[model-bootstrap] 服务器配置拉取失败且无本地兜底,等待网络恢复重试')
      return { ok: true, configured: false, retryable: true }
    }
    if (isAuthed) {
      logger.info('[model-bootstrap] 已登录但服务器/本地均无配置,等待用户配置')
    } else {
      logger.info('[model-bootstrap] 未登录且无本地配置,等待用户配置')
    }
    return { ok: true, configured: false, retryable: false }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    logger.error('[model-bootstrap] 装配失败:', msg)
    agent.setReady(true)
    return { ok: false, configured: false, retryable: true, error: msg }
  }
}
