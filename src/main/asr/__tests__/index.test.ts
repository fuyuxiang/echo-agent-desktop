// @vitest-environment node
// 云端 ASR 切片上传单测(2026-08 重构:本地 sherpa-onnx → 云端 TeleSpeechASR)
//
// 契约:
// 1. Chat 流式:feedAudio 累积 PCM → 每 3s 切片 → multipart POST /audio/transcriptions
//    → 拼到 confirmedText;getResult 返回 confirmedText + partial
// 2. 强制 flush:stopStream 把剩余音频 flush,返回最终完整文本
// 3. Meeting 流式:feedMeetingAudio 累积 + 按固定时长切片 → confirmedSegments
//    → pollMeetingStream 返回 segments + partial
// 4. Meeting flush:stopMeetingStream 把剩余音频 flush,返回最终 segments
// 5. 多 stream 隔离:不同 streamId 互不污染
// 6. 网络/配置错误:不抛崩上层,降级返回空字符串 + 日志
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 注入式 mock:resolveASRConfig 由 config-store 提供,这里独立 mock
const deps = vi.hoisted(() => ({
  resolveASRConfig: vi.fn(),
  fetch: vi.fn()
}))

vi.mock('../config-store', () => ({
  resolveASRConfig: deps.resolveASRConfig
}))
vi.mock('../../logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

// 构造一个 ok Response 的工厂
function okJson(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body)
  } as unknown as Response
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.useFakeTimers()
  // 2026-08 v2:resolveASRConfig 同步返回硬编码默认
  deps.resolveASRConfig.mockReturnValue({
    baseUrl: 'https://api.siliconflow.cn/v1/audio/transcriptions',
    model: 'TeleAI/TeleSpeechASR',
    apiKey: 'sk-test'
  })
  // 默认 fetch:返回空转写
  deps.fetch.mockResolvedValue(okJson({ text: '' }))
  globalThis.fetch = deps.fetch as unknown as typeof fetch
})

afterEach(() => {
  vi.useRealTimers()
})

// 生成指定样本数的 Float32Array(静音,只为触发切片)
function makeSamples(n: number): Float32Array {
  return new Float32Array(n)
}

// 48000 样本 = 3 秒(16kHz)
const SAMPLES_PER_3S = 16000 * 3

describe('Chat 流式 ASR', () => {
  it('createStream 直接成功返回 streamId(默认配置开箱即用)', async () => {
    const { createStream } = await import('../index')
    await expect(createStream()).resolves.toEqual(expect.any(String))
  })

  it('feedAudio 累积到切片时长时自动 POST 上传,getResult 返回转写', async () => {
    deps.fetch.mockResolvedValue(okJson({ text: '你好世界' }))

    const { createStream, feedAudio, getResult, stopStream } = await import('../index')
    const id = await createStream()

    // 累积 3 秒样本(16000*3)
    feedAudio(id, makeSamples(SAMPLES_PER_3S))
    // 切片上传是异步,推进 fake timers + microtask
    await vi.runAllTimersAsync()
    // 切片上传完成后,getResult 已可拿到本次转写(此时 stream 仍在 map 里)
    expect(getResult(id)).toContain('你好世界')

    expect(deps.fetch).toHaveBeenCalledTimes(1)
    const callInit = deps.fetch.mock.calls[0][1] as RequestInit
    expect(String(callInit.method)).toBe('POST')
    // url 应带 baseUrl/audio/transcriptions
    expect(String(deps.fetch.mock.calls[0][0])).toContain('/audio/transcriptions')
    // multipart form: 检查 form 包含 file/model
    const form = callInit.body as FormData
    expect(form).toBeInstanceOf(FormData)
    expect(form.get('model')).toBe('TeleAI/TeleSpeechASR')

    // flush 残余(此时 chunks 已空,不会再 fetch)
    await stopStream(id)
  })

  it('force flush 时把未达切片阈值的剩余音频一并上传', async () => {
    deps.fetch.mockResolvedValue(okJson({ text: '尾段' }))

    const { createStream, feedAudio, stopStream } = await import('../index')
    const id = await createStream()

    // 只喂 1 秒样本(不到 3 秒切片阈值)
    feedAudio(id, makeSamples(16000))
    expect(deps.fetch).not.toHaveBeenCalled() // 未到切片

    // stop 触发强制 flush
    await stopStream(id)
    expect(deps.fetch).toHaveBeenCalledTimes(1)
  })

  it('网络错误时降级:getResult 返回空串,不抛', async () => {
    deps.fetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve('server error'),
      json: () => Promise.resolve({})
    } as unknown as Response)

    const { createStream, feedAudio, stopStream, getResult } = await import('../index')
    const id = await createStream()
    feedAudio(id, makeSamples(SAMPLES_PER_3S))
    await vi.runAllTimersAsync()
    await stopStream(id)

    expect(getResult(id)).toBe('')
  })

  it('多 stream 隔离', async () => {
    let call = 0
    deps.fetch.mockImplementation(async () => {
      call++
      return okJson({ text: `seg-${call}` })
    })

    const { createStream, feedAudio, stopStream } = await import('../index')
    const a = await createStream()
    const b = await createStream()

    feedAudio(a, makeSamples(SAMPLES_PER_3S))
    feedAudio(b, makeSamples(SAMPLES_PER_3S))
    await vi.runAllTimersAsync()
    const textA = await stopStream(a)
    const textB = await stopStream(b)

    // 两个 stream 应各自有自己的转写,互不污染
    expect(textA).toContain('seg-')
    expect(textB).toContain('seg-')
    // 至少 2 次上传(可能更多,如果还有尾段 flush)
    expect(deps.fetch.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})

describe('Meeting 流式 ASR', () => {
  it('feedMeetingAudio 累积 → poll 返回 confirmedSegments + partial', async () => {
    deps.fetch.mockResolvedValue(okJson({ text: '会议片段' }))

    const { createMeetingStream, feedMeetingAudio, pollMeetingStream, stopMeetingStream } =
      await import('../index')
    const id = await createMeetingStream()

    // 累积 3 秒
    feedMeetingAudio(id, makeSamples(SAMPLES_PER_3S))
    await vi.runAllTimersAsync()

    const polledResult = pollMeetingStream(id)
    expect(polledResult.confirmed).toHaveLength(1)
    expect(polledResult.confirmed[0].text).toBe('会议片段')
    expect(polledResult.confirmed[0].endMs - polledResult.confirmed[0].startMs).toBeCloseTo(3000, -1)

    await stopMeetingStream(id)
  })

  it('stopMeetingStream 把剩余音频 flush 为最终 segment', async () => {
    deps.fetch.mockResolvedValue(okJson({ text: '尾段' }))

    const { createMeetingStream, feedMeetingAudio, stopMeetingStream } = await import('../index')
    const id = await createMeetingStream()

    // 只喂 1 秒,未到切片阈值
    feedMeetingAudio(id, makeSamples(16000))

    const r = await stopMeetingStream(id)
    expect(r.confirmed.length).toBeGreaterThanOrEqual(1)
    expect(r.confirmed[r.confirmed.length - 1].text).toBe('尾段')
    expect(deps.fetch).toHaveBeenCalled()
  })
})