import { fetchModelConfig, type ModelConfigDTO } from './server'
import { storage } from '@/utils'
import {
  LOCAL_OLLAMA_CONFIG_KEY,
  toOllamaOpenAIBase,
  type LocalOllamaConfig
} from './model-config'
import { logger } from '@/utils/logger'
import { useAgentStore } from '@/stores/agentStore'

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
  try {
    // C 本地模型(Ollama)优先
    const localModel = await storage.get<LocalOllamaConfig>(LOCAL_OLLAMA_CONFIG_KEY)
    if (localModel?.enabled && localModel.baseUrl && localModel.modelName) {
      // Ollama 走 OpenAI 兼容协议,本身无需 API Key
      await window.api.agentChat.init({
        providerId: 'openai',
        model: localModel.modelName,
        baseUrl: toOllamaOpenAIBase(localModel.baseUrl),
        apiKeyStoreKey: apiKeyStoreKey('ollama')
      })
      agent.setReady(true)
      agent.setConfigured(true)
      logger.info('[model-bootstrap] 本地模型(Ollama)已装配')
      return { ok: true, configured: true, retryable: false }
    }

    // 尝试获取服务器模型配置(需要登录)
    let cfg: ModelConfigDTO
    try {
      cfg = await fetchModelConfig()
    } catch (e) {
      // 网络/超时/未登录:UI 仍可用,但 runtime 未装配。标记 retryable,待网络恢复或登录后重试
      logger.warn('[model-bootstrap] 无法获取服务器模型配置(可能未登录/网络异常):', e)
      agent.setReady(true)
      return { ok: true, configured: false, retryable: true }
    }

    if (!cfg.baseUrl || !cfg.modelName) {
      // 服务器未配置模型:终态,等用户去配置,不必反复重试
      logger.warn('[model-bootstrap] 服务器未配置模型,跳过初始化')
      agent.setReady(true)
      return { ok: true, configured: false, retryable: false }
    }

    // 默认走 openai 兼容协议
    const providerId = 'openai'
    const storeKey = apiKeyStoreKey(providerId)

    // 服务器下发 apiKey 时先存入 safeStorage(方案A);主进程从 safeStorage 读取,渲染层不持有
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
    logger.info(`[model-bootstrap] agent runtime 已装配 provider=${providerId} model=${cfg.modelName}`)
    return { ok: true, configured: true, retryable: false }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    logger.error('[model-bootstrap] 装配失败:', msg)
    // init 抛错多为暂时性(主进程/网络),置就绪让 UI 可用,并允许重试
    agent.setReady(true)
    return { ok: false, configured: false, retryable: true, error: msg }
  }
}
