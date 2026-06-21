import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import type { MemoryEntry } from '@/services/agent/memory'

interface MemoryState {
  entries: MemoryEntry[]
  total: number
  searchResults: Array<{ entry: MemoryEntry; score: number }>
  setEntries: (entries: MemoryEntry[], total: number) => void
  setSearchResults: (results: MemoryState['searchResults']) => void
}

export const useMemoryStore = create<MemoryState>()(
  immer((set) => ({
    entries: [],
    total: 0,
    searchResults: [],
    setEntries: (entries, total) =>
      set((s) => {
        s.entries = entries
        s.total = total
      }),
    setSearchResults: (results) =>
      set((s) => {
        s.searchResults = results
      })
  }))
)
