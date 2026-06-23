import { useCallback, useRef } from 'react'
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

interface Pipeline {
  micStream: MediaStream
  sysStream: MediaStream | null
  context: AudioContext
  processor: ScriptProcessorNode
  pollTimer: ReturnType<typeof setInterval>
  clockTimer: ReturnType<typeof setInterval>
}

export function useMeetingRecorder() {
  const store = useMeetingStore()
  const pipeRef = useRef<Pipeline | null>(null)

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

    let sysStream: MediaStream | null = null
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
      window.api.meeting.feed(meetingId, mixToMono(micData, lastSys))
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

    pipeRef.current = { micStream, sysStream, context, processor, pollTimer, clockTimer }
    store.setActiveMeetingId(meetingId)
    store.setAudioSource(source)
    store.setRecording(true)
    store.setMinimized(false)
  }, [store])

  const stop = useCallback(async () => {
    const p = pipeRef.current
    const id = store.activeMeetingId
    if (!p || !id) return
    clearInterval(p.pollTimer)
    clearInterval(p.clockTimer)
    p.processor.disconnect()
    p.micStream.getTracks().forEach((t) => t.stop())
    p.sysStream?.getTracks().forEach((t) => t.stop())
    await p.context.close()
    pipeRef.current = null
    try {
      await window.api.meeting.stop(id)
      await window.api.meeting.diarize(id)
    } catch (e) {
      logger.error('[meeting] stop failed', e)
    }
    store.setRecording(false)
  }, [store])

  const toggleMinimize = useCallback(() => store.setMinimized(!store.minimized), [store])

  return { ...store, start, stop, toggleMinimize }
}
