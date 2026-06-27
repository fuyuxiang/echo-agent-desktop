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
 */
export async function applyServerModelConfigAndStart(): Promise<{
  ok: boolean
  error?: string
}> {
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
      useAgentStore.getState().setReady(true)
      logger.info('[model-bootstrap] 本地模型(Ollama)已装配')
      return { ok: true }
    }

    // 尝试获取服务器模型配置(需要登录)
    let cfg: ModelConfigDTO
    try {
      cfg = await fetchModelConfig()
    } catch (e) {
      // 未登录或网络错误:跳过服务器配置,不报错,让用户先用界面
      logger.warn('[model-bootstrap] 无法获取服务器模型配置(可能未登录):', e)
      return { ok: true }
    }

    if (!cfg.baseUrl || !cfg.modelName) {
      // 不报错,让用户可以使用界面,在发送消息时再提示配置模型
      logger.warn('[model-bootstrap] 服务器未配置模型,跳过初始化')
      return { ok: true }
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
    useAgentStore.getState().setReady(true)
    logger.info(`[model-bootstrap] agent runtime 已装配 provider=${providerId} model=${cfg.modelName}`)
    return { ok: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    logger.error('[model-bootstrap] 装配失败:', msg)
    return { ok: false, error: msg }
  }
}
