import { app } from 'electron'
import path from 'path'
import { OnlineRecognizer } from 'sherpa-onnx-node'
import { randomUUID } from 'crypto'
import log from 'electron-log/main'

let recognizer: InstanceType<typeof OnlineRecognizer> | null = null
const streams = new Map<string, ReturnType<InstanceType<typeof OnlineRecognizer>['createStream']>>()
/** 每个 stream 的最后活跃时间, 用于清理被遗弃(未调用 stop)的 stream, 防止原生句柄泄漏 */
const streamLastActive = new Map<string, number>()
/** 空闲多久后回收 stream (ms) */
const STREAM_IDLE_TIMEOUT = 5 * 60_000
let reapTimer: ReturnType<typeof setInterval> | null = null

function touchStream(streamId: string): void {
  streamLastActive.set(streamId, Date.now())
}

function discardStream(streamId: string): void {
  streams.delete(streamId)
  streamLastActive.delete(streamId)
}

/** 定期回收空闲 stream: 页面刷新/异常导航导致未调用 stop 时, 兜底释放原生 stream 句柄 */
function ensureReaper(): void {
  if (reapTimer) return
  reapTimer = setInterval(() => {
    const now = Date.now()
    for (const [id, last] of streamLastActive) {
      if (now - last > STREAM_IDLE_TIMEOUT) {
        log.warn(`[ASR] 回收空闲 stream: ${id}`)
        discardStream(id)
      }
    }
    if (streams.size === 0 && reapTimer) {
      clearInterval(reapTimer)
      reapTimer = null
    }
  }, 60_000)
  // 不阻止进程退出
  reapTimer.unref?.()
}

function getModelDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'models', 'asr')
  }
  return path.join(app.getAppPath(), 'resources', 'models', 'asr')
}

export function initASR(): void {
  const modelDir = getModelDir()
  const modelPrefix = 'sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30'
  const modelPath = path.join(modelDir, modelPrefix)

  try {
    recognizer = new OnlineRecognizer({
      modelConfig: {
        transducer: {
          encoder: path.join(modelPath, 'encoder.int8.onnx'),
          decoder: path.join(modelPath, 'decoder.onnx'),
          joiner: path.join(modelPath, 'joiner.int8.onnx')
        },
        tokens: path.join(modelPath, 'tokens.txt'),
        numThreads: 2,
        provider: 'cpu'
      },
      enableEndpoint: true,
      rule1MinTrailingSilence: 2.4,
      rule2MinTrailingSilence: 1.2,
      rule3MinUtteranceLength: 20,
      decodingMethod: 'greedy_search'
    })
    log.info('[ASR] sherpa-onnx recognizer initialized')
  } catch (err) {
    log.error('[ASR] Failed to initialize recognizer:', err)
    recognizer = null
  }
}

export function createStream(): string {
  if (!recognizer) {
    throw new Error('ASR recognizer not initialized')
  }
  const streamId = randomUUID()
  const stream = recognizer.createStream()
  streams.set(streamId, stream)
  touchStream(streamId)
  ensureReaper()
  return streamId
}

export function feedAudio(streamId: string, samples: Float32Array): void {
  if (!recognizer) throw new Error('ASR recognizer not initialized')
  const stream = streams.get(streamId)
  if (!stream) throw new Error(`Stream ${streamId} not found`)
  touchStream(streamId)
  stream.acceptWaveform({ sampleRate: 16000, samples })
  while (recognizer.isReady(stream)) {
    recognizer.decode(stream)
  }
}

export function getResult(streamId: string): string {
  if (!recognizer) return ''
  const stream = streams.get(streamId)
  if (!stream) return ''
  touchStream(streamId)
  return recognizer.getResult(stream).text
}

export function stopStream(streamId: string): string {
  if (!recognizer) return ''
  const stream = streams.get(streamId)
  if (!stream) return ''

  stream.inputFinished()
  while (recognizer.isReady(stream)) {
    recognizer.decode(stream)
  }
  const finalResult = recognizer.getResult(stream).text
  discardStream(streamId)
  return finalResult
}

/** 样本数换算毫秒 */
export function samplesToMs(sampleCount: number, sampleRate = 16000): number {
  return Math.round((sampleCount / sampleRate) * 1000)
}

interface MeetingStreamState {
  totalSamples: number
  segStartSamples: number
  idleConfirmed: { startMs: number; endMs: number; text: string }[]
}
const meetingStates = new Map<string, MeetingStreamState>()

export function createMeetingStream(): string {
  const streamId = createStream()
  meetingStates.set(streamId, { totalSamples: 0, segStartSamples: 0, idleConfirmed: [] })
  return streamId
}

export function feedMeetingAudio(streamId: string, samples: Float32Array): void {
  if (!recognizer) throw new Error('ASR recognizer not initialized')
  const stream = streams.get(streamId)
  const state = meetingStates.get(streamId)
  if (!stream || !state) throw new Error(`Meeting stream ${streamId} not found`)
  touchStream(streamId)
  stream.acceptWaveform({ sampleRate: 16000, samples })
  state.totalSamples += samples.length
  while (recognizer.isReady(stream)) recognizer.decode(stream)
  const curText = recognizer.getResult(stream).text
  const ep = recognizer.isEndpoint(stream)
  // 仅当端点触发且已识别出文本时才定稿+重置;空端点(静音)不重置,
  // 避免把尚未形成文本的声学状态清掉(模型需要更长上下文才出字)
  if (ep && curText) {
    state.idleConfirmed.push({
      startMs: samplesToMs(state.segStartSamples),
      endMs: samplesToMs(state.totalSamples),
      text: curText
    })
    state.segStartSamples = state.totalSamples
    recognizer.reset(stream)
  }
}

export function pollMeetingStream(streamId: string): {
  confirmed: { startMs: number; endMs: number; text: string }[]; partial: string
} {
  const stream = streams.get(streamId)
  const state = meetingStates.get(streamId)
  if (!stream || !state) return { confirmed: [], partial: '' }
  const confirmed = state.idleConfirmed
  state.idleConfirmed = []
  const partial = recognizer ? recognizer.getResult(stream).text : ''
  return { confirmed, partial }
}

export function stopMeetingStream(streamId: string): {
  confirmed: { startMs: number; endMs: number; text: string }[]
} {
  const stream = streams.get(streamId)
  const state = meetingStates.get(streamId)
  if (!stream || !state || !recognizer) {
    meetingStates.delete(streamId)
    return { confirmed: [] }
  }
  stream.inputFinished()
  while (recognizer.isReady(stream)) recognizer.decode(stream)
  const tail = recognizer.getResult(stream).text
  const confirmed = [...state.idleConfirmed]
  if (tail) {
    confirmed.push({
      startMs: samplesToMs(state.segStartSamples),
      endMs: samplesToMs(state.totalSamples),
      text: tail
    })
  }
  discardStream(streamId)
  meetingStates.delete(streamId)
  return { confirmed }
}
