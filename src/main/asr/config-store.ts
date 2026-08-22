/**
 * ASR 默认配置(2026-08 ASR 云端化重构 v2)
 *
 * 2026-08-22 决策修正:不再在设置页暴露 ASR 配置,直接硬编码默认,
 * 开箱即用。后续如需可换,改 DEFAULT_BASE_URL / DEFAULT_MODEL 即可。
 *
 * SECURITY 注意:DEFAULT_API_KEY 是用户主动提供的开发/测试凭证,
 * 仅适用于内部团队使用。生产部署前必须替换为受控凭证源(企业密钥管理、
 * 短期 token 服务等),并配合打包签名与发布流程。
 */

export interface ASRConfigResolved {
  baseUrl: string
  model: string
  apiKey: string
}

/** 硬编码默认:硅基流动 TeleSpeechASR */
const DEFAULT_BASE_URL = 'https://api.siliconflow.cn/v1/audio/transcriptions'
const DEFAULT_MODEL = 'TeleAI/TeleSpeechASR'
const DEFAULT_API_KEY = 'sk-perpdxeyiwcymvnnpvwnjbhavppnchxohcpwydulfkdwpvp'

/**
 * 返回 ASR 客户端可用的完整配置。当前为硬编码默认,同步返回,无失败路径。
 *
 * 保留此函数形态(而非直接 export 常量)是为了:
 * - 未来切换为"用户配置优先,默认兜底"时无需改 asr/index.ts 调用方
 * - 未来切换为"运行时按企业服务器拉配置"时只需替换实现
 */
export function resolveASRConfig(): ASRConfigResolved {
  return {
    baseUrl: DEFAULT_BASE_URL,
    model: DEFAULT_MODEL,
    apiKey: DEFAULT_API_KEY
  }
}