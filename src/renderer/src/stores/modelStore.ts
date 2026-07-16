import { create } from 'zustand'
import type { ModelConfig, ModelAddRequest, ModelUpdateRequest } from '@shared/model-types'

interface ModelState {
  models: ModelConfig[]
  activeModel: ModelConfig | null
  loading: boolean
  error: string | null
  fetchModels: () => Promise<void>
  addModel: (request: ModelAddRequest) => Promise<void>
  updateModel: (request: ModelUpdateRequest) => Promise<void>
  removeModel: (id: string) => Promise<void>
  setActiveModel: (id: string) => Promise<void>
}

export const useModelStore = create<ModelState>()((set, get) => ({
  models: [],
  activeModel: null,
  loading: false,
  error: null,

  fetchModels: async () => {
    set({ loading: true, error: null })
    try {
      const result = await window.api.models.list()
      const active = result.models.find((m) => m.isActive) || null
      set({ models: result.models, activeModel: active, loading: false })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), loading: false })
    }
  },

  addModel: async (request) => {
    set({ loading: true, error: null })
    try {
      const newModel = await window.api.models.add(request)
      const models = [...get().models, newModel]
      const activeModel = newModel.isActive ? newModel : get().activeModel
      set({ models, activeModel, loading: false })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), loading: false })
    }
  },

  updateModel: async (request) => {
    set({ loading: true, error: null })
    try {
      const updatedModel = await window.api.models.update(request)
      const models = get().models.map((m) => (m.id === request.id ? updatedModel : m))
      let activeModel = get().activeModel
      if (updatedModel.isActive) {
        activeModel = updatedModel
      } else if (activeModel?.id === request.id) {
        activeModel = null
      }
      set({ models, activeModel, loading: false })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), loading: false })
    }
  },

  removeModel: async (id) => {
    set({ loading: true, error: null })
    try {
      await window.api.models.remove(id)
      const models = get().models.filter((m) => m.id !== id)
      const activeModel = get().activeModel?.id === id ? null : get().activeModel
      set({ models, activeModel, loading: false })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), loading: false })
    }
  },

  setActiveModel: async (id) => {
    set({ loading: true, error: null })
    try {
      await window.api.models.setActive(id)
      const models = get().models.map((m) => ({ ...m, isActive: m.id === id }))
      const activeModel = models.find((m) => m.id === id) || null
      set({ models, activeModel, loading: false })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), loading: false })
    }
  }
}))
