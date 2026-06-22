import fs from 'fs'
import path from 'path'

const SAMPLE_RATE = 16000

interface RecordingHandle {
  fd: number
  path: string
  dataBytes: number
}
const recordings = new Map<string, RecordingHandle>()

/** Float32 [-1,1] → 16bit PCM LE */
export function floatTo16BitPCM(samples: Float32Array): Buffer {
  const buf = Buffer.allocUnsafe(samples.length * 2)
  for (let i = 0; i < samples.length; i++) {
    let s = Math.max(-1, Math.min(1, samples[i]))
    s = s < 0 ? s * 0x8000 : s * 0x7fff
    buf.writeInt16LE(s | 0, i * 2)
  }
  return buf
}

/** 标准 44 字节 WAV 头(单声道 16bit) */
export function buildWavHeader(dataBytes: number, sampleRate: number): Buffer {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0, 'ascii')
  h.writeUInt32LE(36 + dataBytes, 4)
  h.write('WAVE', 8, 'ascii')
  h.write('fmt ', 12, 'ascii')
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(sampleRate, 24)
  h.writeUInt32LE(sampleRate * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36, 'ascii')
  h.writeUInt32LE(dataBytes, 40)
  return h
}

export function startRecording(meetingId: string, dir: string): string {
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, `${meetingId}.wav`)
  const fd = fs.openSync(filePath, 'w')
  fs.writeSync(fd, buildWavHeader(0, SAMPLE_RATE))
  recordings.set(meetingId, { fd, path: filePath, dataBytes: 0 })
  return filePath
}

export function appendPcm(meetingId: string, samples: Float32Array): void {
  const rec = recordings.get(meetingId)
  if (!rec) return
  const pcm = floatTo16BitPCM(samples)
  fs.writeSync(rec.fd, pcm)
  rec.dataBytes += pcm.length
}

export function finishRecording(meetingId: string): { path: string; totalSamples: number } {
  const rec = recordings.get(meetingId)
  if (!rec) return { path: '', totalSamples: 0 }
  const header = buildWavHeader(rec.dataBytes, SAMPLE_RATE)
  fs.writeSync(rec.fd, header, 0, 44, 0)
  fs.closeSync(rec.fd)
  recordings.delete(meetingId)
  return { path: rec.path, totalSamples: rec.dataBytes / 2 }
}
