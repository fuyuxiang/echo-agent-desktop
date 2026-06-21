import { fetchModelConfig } from './server'
import { storage } from '@/utils'
import {
  LOCAL_OLLAMA_CONFIG_KEY,
  OLLAMA_PLACEHOLDER_API_KEY,
  toOllamaOpenAIBase,
  type LocalOllamaConfig
} from './model-config'
import { logger } from '@/utils/logger'
import { useAgentStore } from '@/stores/agentStore'

/**
 * 方案A: 登录后从服务器拉取模型配置, 生成 echo-agent.yaml 并启动本地 agent。
 *
 * 服务器下发 { baseUrl, modelName, apiKey }。MiniMax 等 OpenAI 兼容端点统一
 * 映射为 provider name=openai + apiBase, apiKey 直接写进 yaml(config-gen 处理)。
 *
 * 优先级: 用户启用本地模型(Ollama)时优先直连本机, 跳过服务端配置。
 */
export async function applyServerModelConfigAndStart(): Promise<{
  ok: boolean
  error?: string
}> {
  try {
    // C 本地模型(Ollama)优先: 启用后直连本机 OpenAI 兼容端点
    const localModel = await storage.get<LocalOllamaConfig>(LOCAL_OLLAMA_CONFIG_KEY)
    if (localModel?.enabled && localModel.baseUrl && localModel.modelName) {
      await window.api.agent.updateConfig({
        defaultModel: localModel.modelName,
        providers: [
          {
            name: 'openai',
            apiBase: toOllamaOpenAIBase(localModel.baseUrl),
            apiKey: OLLAMA_PLACEHOLDER_API_KEY
          }
        ]
      })
      const local = await window.api.agent.start()
      if (local.success && local.port) {
        useAgentStore.getState().setLocalPort(local.port)
        logger.info(`[model-bootstrap] 本地模型(Ollama)已启动 port=${local.port}`)
        return { ok: true }
      }
      return { ok: false, error: local.error ?? 'agent 启动失败' }
    }

    const cfg = await fetchModelConfig()
    if (!cfg.baseUrl || !cfg.modelName) {
      return { ok: false, error: '服务器未配置模型(baseUrl/modelName 为空)' }
    }

    // 生成配置文件: OpenAI 兼容 provider
    await window.api.agent.updateConfig({
      defaultModel: cfg.modelName,
      providers: [
        {
          name: 'openai',
          apiBase: cfg.baseUrl,
          ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {})
        }
      ]
    })

    // 启动本地 agent
    const result = await window.api.agent.start()
    if (result.success && result.port) {
      useAgentStore.getState().setLocalPort(result.port)
      logger.info(`[model-bootstrap] agent 已启动 port=${result.port}`)
      return { ok: true }
    }
    return { ok: false, error: result.error ?? 'agent 启动失败' }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    logger.error('[model-bootstrap] 拉取配置/启动失败:', msg)
    return { ok: false, error: msg }
  }
}
