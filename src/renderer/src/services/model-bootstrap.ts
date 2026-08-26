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

/**
 * 配置来源:
 * - Ollama:本机直连,不需要真实密钥;
 * - 企业模型:只取脱敏元数据,推理经主进程认证代理转发,密钥不下发客户端;
 * - 本地手动模型:只把 safeStorage 引用交给主进程,渲染层不读取密钥。
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
          model: localModel.modelName,
          source: 'ollama'
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

    // ② 已登录:只拉脱敏元数据。真实密钥始终留在服务器。
    let serverFetchFailed = false
    const orgStatus = await window.api.org.status()
    if (orgStatus.loggedIn) {
      let cfg: Awaited<ReturnType<typeof window.api.org.modelConfig>> | null = null
      try {
        cfg = await window.api.org.modelConfig()
      } catch (e) {
        serverFetchFailed = true
        logger.warn('[model-bootstrap] 服务器配置拉取失败,尝试本地兜底:', e)
      }

      if (cfg?.configured && cfg.chatModel && cfg.proxied) {
        agent.setReady(true)
        try {
          await window.api.echoConfig.apply({
            baseUrl: '',
            apiKey: '',
            model: cfg.chatModel,
            source: 'enterprise'
          })
          agent.setConfigured(true)
          logger.info(`[model-bootstrap] 企业模型代理已装配 model=${cfg.chatModel}`)
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
          model: localCfg.modelName,
          source: 'local'
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
    if (serverFetchFailed) {
      // 已登录但服务器配置拉取因网络/超时失败,且无本地兜底:标记可重试,网络恢复后自愈重装配
      logger.info('[model-bootstrap] 服务器配置拉取失败且无本地兜底,等待网络恢复重试')
      return { ok: true, configured: false, retryable: true }
    }
    if (orgStatus.loggedIn) {
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
