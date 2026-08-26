import { secureGet, storeGet } from '../store'

export interface ASRConfigResolved {
  baseUrl: string
  model: string
  apiKey: string
}

export const ASR_API_KEY_STORE_KEY = 'asr-api-key'
export const ASR_BASE_URL_STORE_KEY = 'asr.baseUrl'
export const ASR_MODEL_STORE_KEY = 'asr.model'

const DEFAULT_BASE_URL = 'https://api.siliconflow.cn/v1/audio/transcriptions'
const DEFAULT_MODEL = 'TeleAI/TeleSpeechASR'

/**
 * Resolve ASR credentials without shipping a secret in the application.
 * Managed deployments can inject a short-lived credential via environment;
 * interactive users store it with the operating-system keychain.
 */
export function resolveASRConfig(): ASRConfigResolved {
  const baseUrl =
    process.env.ECHO_ASR_BASE_URL?.trim() ||
    storeGet<string>(ASR_BASE_URL_STORE_KEY)?.trim() ||
    DEFAULT_BASE_URL
  const model =
    process.env.ECHO_ASR_MODEL?.trim() ||
    storeGet<string>(ASR_MODEL_STORE_KEY)?.trim() ||
    DEFAULT_MODEL
  const apiKey =
    process.env.ECHO_ASR_API_KEY?.trim() || secureGet(ASR_API_KEY_STORE_KEY)?.trim() || ''

  if (!apiKey) throw new Error('ASR 尚未配置 API Key，请在设置中配置后重试')

  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new Error('ASR 接口地址无效')
  }
  if (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
    throw new Error('ASR 接口必须使用 HTTPS（本机回环地址除外）')
  }
  return { baseUrl: parsed.toString(), model, apiKey }
}
