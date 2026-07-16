import { create } from 'zustand'
import type { KanbanTask, KanbanAddRequest, KanbanUpdateRequest } from '@shared/kanban-types'

interface KanbanState {
  tasks: KanbanTask[]
  loading: boolean
  error: string | null
  fetchTasks: () => Promise<void>
  addTask: (request: KanbanAddRequest) => Promise<void>
  updateTask: (request: KanbanUpdateRequest) => Promise<void>
  deleteTask: (id: string) => Promise<void>
  moveTask: (id: string, status: string) => Promise<void>
}

export const useKanbanStore = create<KanbanState>((set, get) => ({
  tasks: [],
  loading: false,
  error: null,

  fetchTasks: async () => {
    set({ loading: true, error: null })
    try {
      const result = await window.api.invoke('kanban:listTasks')
      set({ tasks: result.tasks, loading: false })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), loading: false })
    }
  },

  addTask: async (request: KanbanAddRequest) => {
    set({ loading: true, error: null })
    try {
      const newTask = await window.api.invoke('kanban:addTask', request)
      const tasks = [...get().tasks, newTask]
      set({ tasks, loading: false })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), loading: false })
    }
  },

  updateTask: async (request: KanbanUpdateRequest) => {
    set({ loading: true, error: null })
    try {
      const updatedTask = await window.api.invoke('kanban:updateTask', request)
      const tasks = get().tasks.map((t) => (t.id === request.id ? updatedTask : t))
      set({ tasks, loading: false })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), loading: false })
    }
  },

  deleteTask: async (id: string) => {
    set({ loading: true, error: null })
    try {
      await window.api.invoke('kanban:deleteTask', id)
      const tasks = get().tasks.filter((t) => t.id !== id)
      set({ tasks, loading: false })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), loading: false })
    }
  },

  moveTask: async (id: string, status: string) => {
    set({ loading: true, error: null })
    try {
      const updatedTask = await window.api.invoke('kanban:moveTask', { id, status })
      const tasks = get().tasks.map((t) => (t.id === id ? updatedTask : t))
      set({ tasks, loading: false })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), loading: false })
    }
  }
}))
