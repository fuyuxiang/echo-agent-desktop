import path from 'path'
import fs from 'fs'
import { app } from 'electron'

function modelDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'models', 'diarization')
    : path.join(app.getAppPath(), 'resources', 'models', 'diarization')
}

/** 取与 [segStartMs,segEndMs] 重叠时长最大的簇,返回 speaker_N;无重叠 null。
 *  diar 的 start/end 单位为秒,需 *1000 换算为 ms 比较。 */
export function alignSpeaker(
  segStartMs: number,
  segEndMs: number,
  diar: { start: number; end: number; speaker: number }[]
): string | null {
  let best: number | null = null
  let bestOverlap = 0
  for (const d of diar) {
    const overlap = Math.min(segEndMs, d.end * 1000) - Math.max(segStartMs, d.start * 1000)
    if (overlap > bestOverlap) {
      bestOverlap = overlap
      best = d.speaker
    }
  }
  return best === null ? null : `speaker_${best}`
}

/** 自己解析 16kHz 单声道 16bit PCM WAV → Float32Array(/32768)。
 *  不用 sherpa 的 readWave(Electron 下报 External buffers 错)。 */
function readWavFloat32(wavPath: string): Float32Array {
  const buf = fs.readFileSync(wavPath)
  // 跳过 RIFF 头,逐 chunk 查找 "data"
  let offset = 12 // 'RIFF'(4) + size(4) + 'WAVE'(4)
  let dataStart = -1
  let dataLen = 0
  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString('ascii', offset, offset + 4)
    const chunkSize = buf.readUInt32LE(offset + 4)
    if (chunkId === 'data') {
      dataStart = offset + 8
      dataLen = chunkSize
      break
    }
    offset += 8 + chunkSize + (chunkSize & 1) // chunk 按偶数字节对齐
  }
  if (dataStart < 0) throw new Error(`WAV 无 data chunk: ${wavPath}`)
  const end = Math.min(dataStart + dataLen, buf.length)
  const sampleCount = (end - dataStart) >> 1 // 16bit = 2 字节/样本
  const out = new Float32Array(sampleCount)
  for (let i = 0; i < sampleCount; i++) {
    out[i] = buf.readInt16LE(dataStart + i * 2) / 32768
  }
  return out
}

// 原生模块与实例懒加载:避免在非主进程环境(如 vitest)加载原生 addon。
let diarizer: { process(samples: Float32Array): unknown } | null = null

function ensureDiarizer(): { process(samples: Float32Array): unknown } {
  if (diarizer) return diarizer
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { OfflineSpeakerDiarization } = require('sherpa-onnx-node')
  const dir = modelDir()
  diarizer = new OfflineSpeakerDiarization({
    segmentation: { pyannote: { model: path.join(dir, 'segmentation.onnx') } },
    embedding: { model: path.join(dir, 'embedding.onnx') },
    clustering: { numClusters: -1, threshold: 0.5 } // -1=自动估计簇数
  })
  return diarizer!
}

export async function runDiarization(
  wavPath: string
): Promise<{ start: number; end: number; speaker: number }[]> {
  const d = ensureDiarizer()
  const samples = readWavFloat32(wavPath)
  return d.process(samples) as { start: number; end: number; speaker: number }[]
}
