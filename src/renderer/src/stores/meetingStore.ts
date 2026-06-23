import { create } from 'zustand'
import type { SegmentDTO } from '@shared/types/meeting'

interface MeetingState {
  activeMeetingId: string | null
  recording: boolean
  minimized: boolean
  elapsedMs: number
  segments: SegmentDTO[]
  partial: string
  audioSource: 'mic' | 'mic+system'
  setActiveMeetingId: (id: string | null) => void
  setRecording: (v: boolean) => void
  setMinimized: (v: boolean) => void
  setElapsedMs: (v: number) => void
  setSegments: (s: SegmentDTO[]) => void
  setPartial: (s: string) => void
  setAudioSource: (s: 'mic' | 'mic+system') => void
  reset: () => void
}

export const useMeetingStore = create<MeetingState>((set) => ({
  activeMeetingId: null,
  recording: false,
  minimized: false,
  elapsedMs: 0,
  segments: [],
  partial: '',
  audioSource: 'mic',
  setActiveMeetingId: (activeMeetingId) => set({ activeMeetingId }),
  setRecording: (recording) => set({ recording }),
  setMinimized: (minimized) => set({ minimized }),
  setElapsedMs: (elapsedMs) => set({ elapsedMs }),
  setSegments: (segments) => set({ segments }),
  setPartial: (partial) => set({ partial }),
  setAudioSource: (audioSource) => set({ audioSource }),
  reset: () =>
    set({
      activeMeetingId: null,
      recording: false,
      minimized: false,
      elapsedMs: 0,
      segments: [],
      partial: '',
      audioSource: 'mic'
    })
}))
