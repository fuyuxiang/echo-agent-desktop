import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import type { Channel } from '@/services/agent/channels'

interface ChannelState {
  channels: Channel[]
  setChannels: (channels: Channel[]) => void
}

export const useChannelStore = create<ChannelState>()(
  immer((set) => ({
    channels: [],
    setChannels: (channels) =>
      set((s) => {
        s.channels = channels
      })
  }))
)
