import { randomUUID } from 'node:crypto'
import { log } from '../logger'
import { type ASRConfigResolved, resolveASRConfig } from './config-store'

/**
 * 云端 ASR 服务(2026-08 重构:本地 sherpa-onnx → 云端切片上传)
 *
 * 设计要点:
 * - 不再依赖 sherpa-onnx-node / 本地模型,符合"完全移除本地 ASR"的产品决策
 * - 兼容现有 IPC 签名(asr.start/feed/getResult/stop),渲染层零改动
 * - 切片上传:每 3 秒把累积的 PCM 上传到 baseUrl/audio/transcriptions,
 *   返回的转写文本追加到 confirmedText,getResult 返回拼接结果
 * - 强制 flush:stop 时把未达阈值的样本一并提交,防止丢失
 * - 错误降级:fetch 失败 → log.warn + 返回空文本,不抛崩上层
 *
 * 语义对比(与旧 sherpa 本地流式):
 * - sherpa:边说边出字,延迟 < 100ms
 * - 当前:每 3 秒一段,延迟 ~3 秒,API 调用频次大幅下降
 */

const SAMPLE_RATE = 16000
const CHUNK_MS = 3000
const CHUNK_SAMPLES = (SAMPLE_RATE * CHUNK_MS) / 1000 // 48000

/** Chat 流式状态:累积 PCM + 已上传样本位置 + 已确认文本 */
interface ChatStreamState {
  cfg: ASRConfigResolved
  chunks: Float32Array[]
  uploadedSamples: number
  confirmedText: string
  /** 严格串行的上传链，保证切片结果顺序与原始音频一致。 */
  queue: Promise<void>
  stopped: boolean
}

const chatStreams = new Map<string, ChatStreamState>()

/** Meeting 流式状态:在 Chat 基础上加 segments 列表 */
interface MeetingSegment {
  startMs: number
  endMs: number
  text: string
}
interface MeetingStreamState extends ChatStreamState {
  segments: MeetingSegment[]
  partial: string
  // 上次切片边界对应的累计样本位置(用于计算 segment 时间戳)
  segStartSamples: number
  totalSamples: number
}
const meetingStreams = new Map<string, MeetingStreamState>()

/** Float32 [-1,1] → 16bit PCM LE(对齐 diarization.ts 工具) */
function floatTo16BitPCM(samples: Float32Array): Buffer {
  const buf = Buffer.allocUnsafe(samples.length * 2)
  for (let i = 0; i < samples.length; i++) {
    let s = Math.max(-1, Math.min(1, samples[i]))
    s = s < 0 ? s * 0x8000 : s * 0x7fff
    buf.writeInt16LE(s | 0, i * 2)
  }
  return buf
}

/** 构造符合 OpenAI Whisper 协议的 multipart/form-data */
function buildFormData(pcm: Buffer, model: string, sampleRate: number): FormData {
  // 伪造一个 .wav 头(MIME 由 model 自动推断,这里仍以 wav 上传兼容性最好;
  // TeleSpeechASR/Whisper 都接受 wav/pcm/webm/m4a)
  const wavHeader = Buffer.alloc(44)
  wavHeader.write('RIFF', 0, 'ascii')
  wavHeader.writeUInt32LE(36 + pcm.length, 4)
  wavHeader.write('WAVE', 8, 'ascii')
  wavHeader.write('fmt ', 12, 'ascii')
  wavHeader.writeUInt32LE(16, 16)
  wavHeader.writeUInt16LE(1, 20)
  wavHeader.writeUInt16LE(1, 22)
  wavHeader.writeUInt32LE(sampleRate, 24)
  wavHeader.writeUInt32LE(sampleRate * 2, 28)
  wavHeader.writeUInt16LE(2, 32)
  wavHeader.writeUInt16LE(16, 34)
  wavHeader.write('data', 36, 'ascii')
  wavHeader.writeUInt32LE(pcm.length, 40)
  const wavBuf = Buffer.concat([wavHeader, pcm])

  const form = new FormData()
  // Blob 在 Node 22+ / undici 上可用,这里是 Electron Node 环境,Blob 是 global
  form.append('file', new Blob([wavBuf], { type: 'audio/wav' }), 'audio.wav')
  form.append('model', model)
  // response_format: 默认 json;有些服务需要 verbose_json 才返回 segment 时间戳
  form.append('response_format', 'json')
  return form
}

/**
 * 把累积的 PCM 切片上传到云端并返回转写文本。
 * 失败时返回空串(降级,不抛)。
 */
async function uploadChunk(cfg: ASRConfigResolved, samples: Float32Array): Promise<string> {
  if (samples.length === 0) return ''
  const pcm = floatTo16BitPCM(samples)
  const form = buildFormData(pcm, cfg.model, SAMPLE_RATE)
  try {
    const res = await fetch(cfg.baseUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      body: form
    })
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      log.warn(`[ASR] 上传失败 status=${res.status}: ${errText.slice(0, 200)}`)
      return ''
    }
    const json = (await res.json()) as { text?: string }
    return json.text ?? ''
  } catch (e) {
    log.warn('[ASR] 网络错误:', e instanceof Error ? e.message : String(e))
    return ''
  }
}

/** 把数组里的 Float32Array 拼接成一个大数组(避免频繁拷贝,小数据足够) */
function concatSamples(chunks: Float32Array[]): Float32Array {
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Float32Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

/** 从队首精确取出 count 个样本，尾部不足时取全部。 */
function takeSamples(state: ChatStreamState, count: number): Float32Array {
  let taken = 0
  const selected: Float32Array[] = []
  while (taken < count && state.chunks.length > 0) {
    const head = state.chunks[0]
    const need = count - taken
    if (head.length <= need) {
      selected.push(head)
      taken += head.length
      state.chunks.shift()
    } else {
      selected.push(head.slice(0, need))
      state.chunks[0] = head.slice(need)
      taken += need
    }
  }
  return concatSamples(selected)
}

function enqueueChatUpload(state: ChatStreamState, samples: Float32Array): void {
  state.queue = state.queue.then(async () => {
    const text = await uploadChunk(state.cfg, samples)
    if (text) state.confirmedText = state.confirmedText ? `${state.confirmedText} ${text}` : text
    state.uploadedSamples += samples.length
  })
}

/** 把累积的 chunks 合并,超过阈值的部分立即触发上传 */
function maybeFlushChat(state: ChatStreamState): void {
  const pendingSamples = state.chunks.reduce((n, c) => n + c.length, 0)
  const fullChunks = Math.floor(pendingSamples / CHUNK_SAMPLES)
  for (let i = 0; i < fullChunks; i++) {
    enqueueChatUpload(state, takeSamples(state, CHUNK_SAMPLES))
  }
}

/** 强制把累积的 chunks 全部上传(同步等待 Promise),用于 stop */
async function forceFlushChat(state: ChatStreamState): Promise<void> {
  const remaining = state.chunks.reduce((n, c) => n + c.length, 0)
  if (remaining > 0) {
    enqueueChatUpload(state, takeSamples(state, remaining))
  }
  await state.queue
}

// =================== Chat 流式 API ===================

export async function createStream(): Promise<string> {
  // 2026-08 v2:resolveASRConfig 改为同步(默认 baseUrl/model/apiKey 硬编码),
  // 但保留 async 函数形态以兼容 IPC handler 与上层 await 调用。
  const cfg = resolveASRConfig()
  const streamId = randomUUID()
  chatStreams.set(streamId, {
    cfg,
    chunks: [],
    uploadedSamples: 0,
    confirmedText: '',
    queue: Promise.resolve(),
    stopped: false
  })
  log.info(`[ASR] stream ${streamId} created(baseUrl=${cfg.baseUrl})`)
  return streamId
}

export function feedAudio(streamId: string, samples: Float32Array): void {
  const state = chatStreams.get(streamId)
  if (!state || state.stopped) return
  state.chunks.push(samples)
  maybeFlushChat(state)
}

export function getResult(streamId: string): string {
  const state = chatStreams.get(streamId)
  if (!state) return ''
  return state.confirmedText
}

export async function stopStream(streamId: string): Promise<string> {
  const state = chatStreams.get(streamId)
  if (!state) return ''
  state.stopped = true
  await forceFlushChat(state)
  const text = state.confirmedText
  chatStreams.delete(streamId)
  log.info(`[ASR] stream ${streamId} stopped, text=${text.length} chars`)
  return text
}

// =================== Meeting 流式 API(基于 Chat 的扩展) ===================

/** 把 Chat 的 maybeFlushChat 复制给 Meeting,但额外写 segments */
function maybeFlushMeeting(state: MeetingStreamState): void {
  const pendingSamples = state.chunks.reduce((n, c) => n + c.length, 0)
  const fullChunks = Math.floor(pendingSamples / CHUNK_SAMPLES)
  for (let i = 0; i < fullChunks; i++) {
    enqueueMeetingUpload(state, takeSamples(state, CHUNK_SAMPLES))
  }
}

function enqueueMeetingUpload(state: MeetingStreamState, samples: Float32Array): void {
  const startSamples = state.segStartSamples
  state.segStartSamples += samples.length
  state.queue = state.queue.then(async () => {
    const text = await uploadChunk(state.cfg, samples)
    if (text) {
      state.segments.push({
        startMs: Math.round((startSamples / SAMPLE_RATE) * 1000),
        endMs: Math.round(((startSamples + samples.length) / SAMPLE_RATE) * 1000),
        text
      })
      state.partial = text
    }
    state.uploadedSamples += samples.length
  })
}

async function forceFlushMeeting(state: MeetingStreamState): Promise<void> {
  const remaining = state.chunks.reduce((n, c) => n + c.length, 0)
  if (remaining > 0) {
    enqueueMeetingUpload(state, takeSamples(state, remaining))
  }
  await state.queue
}

export async function createMeetingStream(): Promise<string> {
  const cfg = resolveASRConfig()
  const streamId = randomUUID()
  meetingStreams.set(streamId, {
    cfg,
    chunks: [],
    uploadedSamples: 0,
    confirmedText: '',
    queue: Promise.resolve(),
    stopped: false,
    segments: [],
    partial: '',
    segStartSamples: 0,
    totalSamples: 0
  })
  log.info(`[ASR/meeting] stream ${streamId} created`)
  return streamId
}

export function feedMeetingAudio(streamId: string, samples: Float32Array): void {
  const state = meetingStreams.get(streamId)
  if (!state || state.stopped) return
  state.chunks.push(samples)
  state.totalSamples += samples.length
  maybeFlushMeeting(state)
}

export function pollMeetingStream(streamId: string): {
  confirmed: MeetingSegment[]
  partial: string
} {
  const state = meetingStreams.get(streamId)
  if (!state) return { confirmed: [], partial: '' }
  // poll 时清空已读 confirmed,保留 partial
  const confirmed = state.segments
  state.segments = []
  return { confirmed, partial: state.partial }
}

export async function stopMeetingStream(streamId: string): Promise<{ confirmed: MeetingSegment[] }> {
  const state = meetingStreams.get(streamId)
  if (!state) return { confirmed: [] }
  state.stopped = true
  await forceFlushMeeting(state)
  const confirmed = state.segments
  meetingStreams.delete(streamId)
  log.info(`[ASR/meeting] stream ${streamId} stopped, segments=${confirmed.length}`)
  return { confirmed }
}

// 内部暴露,给可能的后续诊断/测试用
export const _internals = {
  chatStreams,
  meetingStreams,
  CHUNK_SAMPLES,
  SAMPLE_RATE
}
