import { log } from '../logger'
import { storeDelete, storeGet, storeSet, secureDelete, secureGet, secureSet } from '../store'

/**
 * ASR 配置存储(2026-08 ASR 云端化重构)
 *
 * 设计原则(对齐 LLM 配置的 ref 模式,见 src/main/echo-agent/index.ts:resolveApiKey):
 * - 真实 apiKey 落 safeStorage(系统级加密:mac Keychain / win DPAPI)
 * - 普通 store 仅存 baseUrl/model/apiKeyRef,绝不落明文
 * - 渲染层拿不到真实 key,即便页面被注入脚本也偷不走
 * - 缺配置或不完整时 resolveASRConfig 抛错,ASR client 据此友好提示用户
 */

/** safeStorage 命名空间下的 ASR key,与 openai-api-key 平级 */
export const ASR_SECURE_KEY = 'asr-api-key'

/** 普通 store 下的 ASR 配置 key */
export const ASR_STORE_KEY = 'asrConfig.local'

/** ref 引用前缀,与 echo-agent 的 apiKeyRef 引用协议一致 */
export const ASR_KEY_REFERENCE_PREFIX = 'ref:'

/** 渲染层保存的 ASR 配置(不含真实 key,仅含 ref 指针) */
export interface ASRConfigPersisted {
  baseUrl: string
  model: string
  /** 形如 "ref:asr-api-key",主进程内部据此从 safeStorage 取真值 */
  apiKeyRef?: string
}

/** 渲染层保存时提交的原始形态(含明文 apiKey,主进程负责拆分存储) */
export interface ASRConfigInput {
  baseUrl: string
  model: string
  apiKey?: string
}

/** ASR client 实际使用的完整配置(已解引用) */
export interface ASRConfigResolved {
  baseUrl: string
  model: string
  apiKey: string
}

/** 未配置或不完整时抛出,调用方据此引导用户去设置页 */
export class AsrNotConfiguredError extends Error {
  constructor(message = 'ASR 未配置或配置不完整') {
    super(message)
    this.name = 'AsrNotConfiguredError'
  }
}

/**
 * 保存 ASR 配置:把明文 apiKey 落 safeStorage,baseUrl/model/ref 落普通 store。
 * apiKey 为空时不写入(允许只配 baseUrl/model,用于无认证接口)。
 */
export function saveASRConfig(input: ASRConfigInput): void {
  const persisted: ASRConfigPersisted = {
    baseUrl: input.baseUrl,
    model: input.model
  }
  if (input.apiKey) {
    secureSet(ASR_SECURE_KEY, input.apiKey)
    persisted.apiKeyRef = `${ASR_KEY_REFERENCE_PREFIX}${ASR_SECURE_KEY}`
  } else {
    // 用户主动清空 apiKey 时同步清理 safeStorage,不留残留
    secureDelete(ASR_SECURE_KEY)
    delete persisted.apiKeyRef
  }
  storeSet(ASR_STORE_KEY, persisted)
  log.info('[asr-config] 配置已保存:', { baseUrl: persisted.baseUrl, model: persisted.model, hasKey: !!persisted.apiKeyRef })
}

/** 读取已持久化的配置(ref 指针形态,不含真实 apiKey) */
export function getASRConfig(): ASRConfigPersisted | undefined {
  return storeGet<ASRConfigPersisted>(ASR_STORE_KEY)
}

/**
 * 异步解引用,返回 ASR client 实际可用的完整配置。
 * 缺配置/apiKeyRef/safeStorage 取不到值 → 抛 AsrNotConfiguredError。
 * 设计:绝不静默 fallback 到空字符串,防止启动期 silent 用错 key 上传。
 */
export async function resolveASRConfig(): Promise<ASRConfigResolved> {
  const persisted = getASRConfig()
  if (!persisted?.baseUrl || !persisted.model) {
    throw new AsrNotConfiguredError('ASR baseUrl 或 model 缺失')
  }
  if (!persisted.apiKeyRef) {
    throw new AsrNotConfiguredError('ASR apiKey 未配置')
  }
  // apiKeyRef 形如 "ref:asr-api-key",剥掉前缀取真实 storeKey
  const storeKey = persisted.apiKeyRef.startsWith(ASR_KEY_REFERENCE_PREFIX)
    ? persisted.apiKeyRef.slice(ASR_KEY_REFERENCE_PREFIX.length)
    : persisted.apiKeyRef
  const realApiKey = secureGet(storeKey)
  if (!realApiKey) {
    throw new AsrNotConfiguredError(`safeStorage 中找不到 apiKey: ${storeKey}`)
  }
  return {
    baseUrl: persisted.baseUrl,
    model: persisted.model,
    apiKey: realApiKey
  }
}

/**
 * 清空 ASR 配置(普通 store + safeStorage 同步清,不留残留)。
 * 用于登出/重置场景,防"清一半"串台。
 */
export function clearASRConfig(): void {
  storeDelete(ASR_STORE_KEY)
  secureDelete(ASR_SECURE_KEY)
  log.info('[asr-config] 配置已清空')
}