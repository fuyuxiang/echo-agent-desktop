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
 * 方案A: 登录后从服务器拉取模型配置,下发到 echo-agent。
 *
 * 流程:拿 { baseUrl, apiKey, model } -> window.api.echoConfig.apply 写入 yaml 并重启 echo-agent 进程。
 * apiKey 明文随 apply 传入(写进 yaml),不再走 safeStorage。
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
    // ① Ollama 本地模型(显式启用,最高优先)
    const localModel = await storage.get<LocalOllamaConfig>(LOCAL_OLLAMA_CONFIG_KEY)
    if (localModel?.enabled && localModel.baseUrl && localModel.modelName) {
      // 先解除 UI 遮罩再触发装配:apply 会 await 主进程 restart(写 yaml + spawn gateway
      // + 等 ready 信号,最长 120s,首启还含 pip 安装)。ready 是"UI 可用门",不应被这整条
      // 后台装配链拖住;configured 仍在 apply 成功后置位,保证发送前能判断 runtime 是否真装好。
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
        agent.setReady(true)
        try {
          await window.api.echoConfig.apply({
            baseUrl: cfg.baseUrl,
            apiKey: cfg.apiKey ?? '',
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
    const localCfg = await storage.get<{
      baseUrl: string
      modelName: string
      apiKey?: string
    }>(LOCAL_CONFIG_KEY)
    if (localCfg?.baseUrl && localCfg?.modelName) {
      agent.setReady(true)
      try {
        await window.api.echoConfig.apply({
          baseUrl: localCfg.baseUrl,
          apiKey: localCfg.apiKey ?? '',
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
