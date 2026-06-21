import { fetchModelConfig } from './server'
import { logger } from '@/utils/logger'
import { useAgentStore } from '@/stores/agentStore'

/**
 * 方案A: 登录后从服务器拉取模型配置, 生成 echo-agent.yaml 并启动本地 agent。
 *
 * 服务器下发 { baseUrl, modelName, apiKey }。MiniMax 等 OpenAI 兼容端点统一
 * 映射为 provider name=openai + apiBase, apiKey 直接写进 yaml(config-gen 处理)。
 */
export async function applyServerModelConfigAndStart(): Promise<{
  ok: boolean
  error?: string
}> {
  try {
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
