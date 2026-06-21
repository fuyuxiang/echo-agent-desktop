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
        // 仅在切换成功时才更新本地状态, 失败时保留先前生效的范围,
        // 让 UI 继续展示实际生效的访问范围
        if (result.success) {
          set((s) => {
            s.scope = scope
            s.workspaceDir = workspaceDir
          })
        }
        return result
      } catch (err) {
        // IPC 整体 reject(非 {success:false}) 时也转为失败结果, 避免未处理的 promise rejection
        return { success: false, error: err instanceof Error ? err.message : String(err) }
      } finally {
        set((s) => {
          s.switching = false
        })
      }
    }
  }))
)
