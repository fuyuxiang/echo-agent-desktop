import { useCallback } from 'react'
import { useMeetingStore } from '@/stores/meetingStore'
import { permission } from '@/utils/permission'
import { toast } from '@/components/Toast'
import { logger } from '@/utils/logger'

/** 两路 Float32 混成单路单声道,按较短长度对齐并 clamp 到 [-1,1] */
export function mixToMono(a: Float32Array, b: Float32Array | null): Float32Array {
  if (!b) return a.slice()
  const n = Math.min(a.length, b.length)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    out[i] = Math.max(-1, Math.min(1, a[i] + b[i]))
  }
  return out
}

/**
 * 自适应增益:麦克风信号常偏弱(peak 仅 0.01~0.1),ASR 在弱信号上识别差。
 * 按本帧峰值动态放大到目标峰值附近(上限 12 倍),再 clamp 到 [-1,1]。
 * 纯静音帧(峰值极小)不放大,避免放大底噪。
 */
export function applyGain(samples: Float32Array, targetPeak = 0.5, maxGain = 12): Float32Array {
  let peak = 0
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i])
    if (v > peak) peak = v
  }
  if (peak < 0.002) return samples // 静音帧,不放大底噪
  const gain = Math.min(maxGain, targetPeak / peak)
  if (gain <= 1) return samples
  const out = new Float32Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    out[i] = Math.max(-1, Math.min(1, samples[i] * gain))
  }
  return out
}

interface Pipeline {
  micStream: MediaStream
  sysStream: MediaStream | null
  context: AudioContext
  processor: ScriptProcessorNode
  pollTimer: ReturnType<typeof setInterval>
  clockTimer: ReturnType<typeof setInterval>
}

/**
 * 录制管线单例:useMeetingRecorder 在多处(Chat 输入栏、LivePanel 浮窗)被分别调用,
 * 各自的 useRef 互不相通。若用 useRef 存管线,会出现「A 实例 start 把管线存进自己的 ref,
 * B 实例 stop 时读到的是 null 而直接 return」的 bug,导致停止录制后窗口不消失、资源不释放。
 * 故提升为模块级单例,让所有 hook 实例共享同一份管线引用。
 */
let activePipeline: Pipeline | null = null

export function useMeetingRecorder() {
  const store = useMeetingStore()

  const start = useCallback(async () => {
    if (store.recording) {
      store.setMinimized(false)
      return
    }
    const mic = await permission.request('microphone')
    if (mic !== 'granted') {
      toast.error('麦克风权限未开启')
      return
    }

    let micStream: MediaStream
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      toast.error('无法访问麦克风')
      return
    }

    let sysStream: MediaStream | null
    try {
      sysStream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
      sysStream.getVideoTracks().forEach((t) => t.stop())
      if (sysStream.getAudioTracks().length === 0) sysStream = null
    } catch {
      sysStream = null
    }

    const { meetingId } = await window.api.meeting.start()
    const source: 'mic' | 'mic+system' = sysStream ? 'mic+system' : 'mic'
    if (!sysStream) toast.info('未捕获到系统声音,仅录制麦克风')
    await window.api.meeting.markSource(meetingId, source)

    const context = new AudioContext({ sampleRate: 16000 })
    const micSrc = context.createMediaStreamSource(micStream)
    const processor = context.createScriptProcessor(4096, 1, 1)
    let lastSys: Float32Array | null = null
    if (sysStream) {
      const sysSrc = context.createMediaStreamSource(sysStream)
      const sysProc = context.createScriptProcessor(4096, 1, 1)
      sysProc.onaudioprocess = (e) => {
        lastSys = new Float32Array(e.inputBuffer.getChannelData(0))
      }
      sysSrc.connect(sysProc)
      sysProc.connect(context.destination)
    }
    processor.onaudioprocess = (e) => {
      const micData = new Float32Array(e.inputBuffer.getChannelData(0))
      const mixed = mixToMono(micData, lastSys)
      window.api.meeting.feed(meetingId, applyGain(mixed))
    }
    micSrc.connect(processor)
    processor.connect(context.destination)

    const startedAt = Date.now()
    const pollTimer = setInterval(async () => {
      const { segments, partial } = await window.api.meeting.poll(meetingId)
      store.setSegments(segments)
      store.setPartial(partial)
    }, 500)
    const clockTimer = setInterval(() => store.setElapsedMs(Date.now() - startedAt), 1000)

    activePipeline = { micStream, sysStream, context, processor, pollTimer, clockTimer }
    store.setActiveMeetingId(meetingId)
    store.setAudioSource(source)
    store.setRecording(true)
    store.setMinimized(false)
  }, [store])

  const stop = useCallback(async () => {
    const p = activePipeline
    const id = store.activeMeetingId
    // 即使管线已被清理,只要还有 activeMeetingId 就要把录制态复位,避免浮窗残留
    if (p) {
      clearInterval(p.pollTimer)
      clearInterval(p.clockTimer)
      p.processor.disconnect()
      p.micStream.getTracks().forEach((t) => t.stop())
      p.sysStream?.getTracks().forEach((t) => t.stop())
      await p.context.close()
      activePipeline = null
    }
    if (id) {
      try {
        await window.api.meeting.stop(id)
        await window.api.meeting.diarize(id)
      } catch (e) {
        logger.error('[meeting] stop failed', e)
      }
    }
    store.setRecording(false)
    store.setMinimized(false)
  }, [store])

  const toggleMinimize = useCallback(() => store.setMinimized(!store.minimized), [store])

  return { ...store, start, stop, toggleMinimize }
}
