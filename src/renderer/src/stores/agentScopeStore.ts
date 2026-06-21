import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import type { AccessScope, AgentStartResult } from '@shared/types'

interface AgentScopeState {
  scope: AccessScope
  workspaceDir: string
  switching: boolean
  loadScope: () => Promise<void>
  applyScope: (scope: AccessScope, workspaceDir: string) => Promise<AgentStartResult>
}

export const useAgentScopeStore = create<AgentScopeState>()(
  immer((set) => ({
    scope: 'full',
    workspaceDir: '',
    switching: false,

    loadScope: async () => {
      const cfg = await window.api.agent.getScope()
      set((s) => {
        s.scope = cfg.scope
        s.workspaceDir = cfg.workspaceDir
      })
    },

    applyScope: async (scope, workspaceDir) => {
      set((s) => {
        s.switching = true
      })
      try {
        const result = await window.api.agent.setScope({ scope, workspaceDir })
        set((s) => {
          s.scope = scope
          s.workspaceDir = workspaceDir
        })
        return result
      } finally {
        set((s) => {
          s.switching = false
        })
      }
    }
  }))
)
