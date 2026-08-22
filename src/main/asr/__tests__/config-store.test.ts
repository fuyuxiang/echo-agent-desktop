// @vitest-environment node
// ASR 配置存储单测(纯函数,通过依赖注入测试)
//
// 契约:
// 1. saveASRConfig({ baseUrl, model, apiKey }) 把真实 apiKey 落 safeStorage,
//    普通 store 只存 baseUrl/model/apiKeyRef 引用——绝不落明文 apiKey。
// 2. getASRConfig() 返回 { baseUrl, model, apiKeyRef? } 不含真实 key。
// 3. resolveASRConfig() 异步解引用,返回带真实 apiKey 的完整配置(供 ASR client 用)。
// 4. 配置缺失或不完整时,createStream / startMeetingStream 抛错。
import { beforeEach, describe, expect, it, vi } from 'vitest'

// 注入式依赖:测试时 mock,不依赖 electron-store / safeStorage
const deps = vi.hoisted(() => ({
  storeGet: vi.fn(),
  storeSet: vi.fn(),
  storeDelete: vi.fn(),
  secureGet: vi.fn(),
  secureSet: vi.fn(),
  secureDelete: vi.fn()
}))

vi.mock('../../store', () => ({
  storeGet: deps.storeGet,
  storeSet: deps.storeSet,
  storeDelete: deps.storeDelete,
  secureGet: deps.secureGet,
  secureSet: deps.secureSet,
  secureDelete: deps.secureDelete
}))

vi.mock('../../logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
})

describe('ASR 配置存储契约', () => {
  it('saveASRConfig 把 apiKey 落 safeStorage,普通 store 仅存引用', async () => {
    const { saveASRConfig, ASR_KEY_REFERENCE_PREFIX, ASR_SECURE_KEY } = await import(
      '../config-store'
    )

    saveASRConfig({
      baseUrl: 'https://api.siliconflow.cn/v1/audio/transcriptions',
      model: 'TeleAI/TeleSpeechASR',
      apiKey: 'sk-perpdxeyiwcymvnnpvwnjbhavppnchxohcpwydulfkdwpvp'
    })

    // 真实 apiKey 落 safeStorage,key 固定为 'asr-api-key'
    expect(deps.secureSet).toHaveBeenCalledWith(
      ASR_SECURE_KEY,
      'sk-perpdxeyiwcymvnnpvwnjbhavppnchxohcpwydulfkdwpvp'
    )
    // 普通 store 仅存引用串 'ref:asr-api-key',绝不落明文
    expect(deps.storeSet).toHaveBeenCalledWith('asrConfig.local', {
      baseUrl: 'https://api.siliconflow.cn/v1/audio/transcriptions',
      model: 'TeleAI/TeleSpeechASR',
      apiKeyRef: `${ASR_KEY_REFERENCE_PREFIX}asr-api-key`
    })
    // 关键断言:普通 store 入参里绝对不能含明文 apiKey
    const stored = deps.storeSet.mock.calls[0][1] as Record<string, unknown>
    expect(JSON.stringify(stored)).not.toContain('sk-perpdxeyiwcymvnnpvwnjbhavppnchxohcpwydulfkdwpvp')
  })

  it('getASRConfig 不返回真实 apiKey,只返回 ref 指针', async () => {
    deps.storeGet.mockReturnValueOnce({
      baseUrl: 'https://api.siliconflow.cn/v1',
      model: 'TeleAI/TeleSpeechASR',
      apiKeyRef: 'ref:asr-api-key'
    })
    const { getASRConfig } = await import('../config-store')

    const cfg = getASRConfig()
    expect(cfg).toEqual({
      baseUrl: 'https://api.siliconflow.cn/v1',
      model: 'TeleAI/TeleSpeechASR',
      apiKeyRef: 'ref:asr-api-key'
    })
    // 明确断言:配置对象上没有任何明文 apiKey 字段
    expect((cfg as unknown as Record<string, unknown>).apiKey).toBeUndefined()
  })

  it('resolveASRConfig 异步解引用,返回完整配置(含真实 apiKey)供 client 使用', async () => {
    deps.storeGet.mockReturnValueOnce({
      baseUrl: 'https://api.siliconflow.cn/v1',
      model: 'TeleAI/TeleSpeechASR',
      apiKeyRef: 'ref:asr-api-key'
    })
    deps.secureGet.mockReturnValueOnce('sk-real-key-from-keystore')
    const { resolveASRConfig } = await import('../config-store')

    const full = await resolveASRConfig()
    expect(full).toEqual({
      baseUrl: 'https://api.siliconflow.cn/v1',
      model: 'TeleAI/TeleSpeechASR',
      apiKey: 'sk-real-key-from-keystore'
    })
  })

  it('未配置时 resolveASRConfig 抛 AsrNotConfiguredError,start 链路据此抛错', async () => {
    deps.storeGet.mockReturnValueOnce(undefined)
    const { resolveASRConfig, AsrNotConfiguredError } = await import('../config-store')

    await expect(resolveASRConfig()).rejects.toBeInstanceOf(AsrNotConfiguredError)
  })

  it('apiKeyRef 缺失时抛错(配置不完整,不能 fallback 到明文)', async () => {
    deps.storeGet.mockReturnValueOnce({
      baseUrl: 'https://api.siliconflow.cn/v1',
      model: 'TeleAI/TeleSpeechASR'
      // apiKeyRef 缺失
    })
    const { resolveASRConfig, AsrNotConfiguredError } = await import('../config-store')

    await expect(resolveASRConfig()).rejects.toBeInstanceOf(AsrNotConfiguredError)
  })

  it('safeStorage 中找不到 apiKey 时抛错(防止启动期 silent 用空 key)', async () => {
    deps.storeGet.mockReturnValueOnce({
      baseUrl: 'https://api.siliconflow.cn/v1',
      model: 'TeleAI/TeleSpeechASR',
      apiKeyRef: 'ref:asr-api-key'
    })
    deps.secureGet.mockReturnValueOnce(undefined)
    const { resolveASRConfig, AsrNotConfiguredError } = await import('../config-store')

    await expect(resolveASRConfig()).rejects.toBeInstanceOf(AsrNotConfiguredError)
  })

  it('clearASRConfig 同时清空普通 store 与 safeStorage(不留残留,防串台)', async () => {
    const { clearASRConfig, ASR_SECURE_KEY } = await import('../config-store')

    clearASRConfig()
    expect(deps.storeDelete).toHaveBeenCalledWith('asrConfig.local')
    expect(deps.secureDelete).toHaveBeenCalledWith(ASR_SECURE_KEY)
  })
})