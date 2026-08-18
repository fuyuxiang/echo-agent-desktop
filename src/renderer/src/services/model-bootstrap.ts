import { fetchModelConfig, type ModelConfigDTO } from './server'
import { storage } from '@/utils'
import {
  LOCAL_CONFIG_KEY,
  LOCAL_OLLAMA_CONFIG_KEY,
  OLLAMA_PLACEHOLDER_API_KEY,
  toOllamaOpenAIBase,
  type LocalOllamaConfig
} from './model-config'
import { logger } from '@/utils/logger'
import { useAgentStore } from '@/stores/agentStore'
import { useUserStore } from '@/stores/userStore'

/**
 * 配置来源(2026-08 P0-7 合规修复):
 * - 真实 apiKey 始终走 safeStorage(API_KEY_STORE_KEY = 'openai-api-key')
 * - 写入 echo-agent.yaml 时:apiKey 字段是占位符 `ref:<storeKey>`
 * - 主进程 applyModelConfig 收到 `ref:` 前缀的 apiKey 时,从 safeStorage 取真实值注入到 yaml
 * - 切勿把真实 apiKey 写入 LOCAL_CONFIG_KEY 或随 apply 透传
 */

export async function applyServerModelConfigAndStart(): Promise<{
  ok: boolean
  configured: boolean
  retryable: boolean
  error?: string
}> {
  const agent = useAgentStore.getState()

  try {
    // ① Ollama 本地模型(显式启用,最高优先)
    const localModel = await storage.get<LocalOllamaConfig>(LOCAL_OLLAMA_CONFIG_KEY)
    if (localModel?.enabled && localModel.baseUrl && localModel.modelName) {
      agent.setReady(true)
      try {
        await window.api.echoConfig.apply({
          baseUrl: toOllamaOpenAIBase(localModel.baseUrl),
          apiKey: OLLAMA_PLACEHOLDER_API_KEY,
          model: localModel.modelName
        })
        agent.setConfigured(true)
        logger.info('[model-bootstrap] Ollama 本地模型已装配')
        return { ok: true, configured: true, retryable: false }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        logger.error('[model-bootstrap] Ollama 配置应用失败:', msg)
        return { ok: false, configured: false, retryable: true, error: msg }
      }
    }

    // ② 已登录:从服务器拉取配置(apiKey 是引用,不存明文)
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
        agent.setReady(true)
        try {
          await window.api.echoConfig.apply({
            baseUrl: cfg.baseUrl,
            // 服务器下发的 apiKey 仅作为临时引用,主进程收到后通过 secureGet 取真值
            apiKey: `ref:server-provided:${cfg.modelName}`,
            model: cfg.modelName
          })
          agent.setConfigured(true)
          logger.info(`[model-bootstrap] 服务器配置已装配 model=${cfg.modelName}`)
          return { ok: true, configured: true, retryable: false }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          logger.error('[model-bootstrap] 服务器配置应用失败:', msg)
          return { ok: false, configured: false, retryable: true, error: msg }
        }
      }
      // 服务器无有效配置,fall through 到本地手动配置
    }

    // ③ 本地手动配置(未登录的唯一来源 / 已登录但服务器未配置的兜底)
    // apiKeyRef 是非安全存储里存的引用指针(如 'openai-api-key'),不是真值。
    const localCfg = await storage.get<{
      baseUrl: string
      modelName: string
      apiKeyRef?: string
    }>(LOCAL_CONFIG_KEY)
    if (localCfg?.baseUrl && localCfg?.modelName) {
      agent.setReady(true)
      try {
        await window.api.echoConfig.apply({
          baseUrl: localCfg.baseUrl,
          apiKey: localCfg.apiKeyRef ? `ref:${localCfg.apiKeyRef}` : '',
          model: localCfg.modelName
        })
        agent.setConfigured(true)
        logger.info(`[model-bootstrap] 本地手动配置已装配 model=${localCfg.modelName}`)
        return { ok: true, configured: true, retryable: false }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        logger.error('[model-bootstrap] 本地配置应用失败:', msg)
        return { ok: false, configured: false, retryable: true, error: msg }
      }
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
