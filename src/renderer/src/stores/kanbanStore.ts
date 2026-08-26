import { create } from 'zustand'
import type { KanbanTask, KanbanAddRequest, KanbanUpdateRequest, KanbanStatus, KanbanPriority } from '@shared/kanban-types'
import { agentManagement } from '@/services/agent/management'

type AgentTask = {
  id: string
  title: string
  description: string
  status: string
  priority: number
  assignee: string
  metadata: Record<string, unknown>
  created_at: string
  updated_at: string
}

const STATUS_FROM_AGENT: Record<string, KanbanStatus> = {
  pending: 'todo', queued: 'ready', running: 'running', blocked: 'blocked',
  review: 'review', success: 'done', failed: 'blocked', cancelled: 'archived',
  suspended: 'scheduled'
}
const STATUS_TO_AGENT: Record<KanbanStatus, string> = {
  triage: 'pending', todo: 'pending', scheduled: 'suspended', ready: 'queued',
  running: 'running', blocked: 'blocked', review: 'review', done: 'success', archived: 'cancelled'
}
const PRIORITY_TO_AGENT: Record<KanbanPriority, number> = { critical: 1, high: 3, medium: 5, low: 8 }

function priorityFromAgent(value: number): KanbanPriority {
  if (value <= 2) return 'critical'
  if (value <= 4) return 'high'
  if (value <= 6) return 'medium'
  return 'low'
}

function fromAgent(task: AgentTask): KanbanTask {
  return {
    id: task.id,
    title: task.title,
    description: task.description || undefined,
    status: STATUS_FROM_AGENT[task.status] ?? 'todo',
    priority: priorityFromAgent(task.priority),
    assignee: task.assignee || undefined,
    metadata: task.metadata,
    createdAt: task.created_at,
    updatedAt: task.updated_at
  }
}

async function listTasks(): Promise<KanbanTask[]> {
  const result = await agentManagement<{ tasks: AgentTask[] }>({ method: 'GET', path: '/tasks?board_id=default' })
  return result.tasks.map(fromAgent)
}

async function transition(id: string, status: KanbanStatus): Promise<KanbanTask> {
  if (status === 'running') throw new Error('Agent 任务只能由调度器从排队状态进入执行中')
  const result = await agentManagement<{ task: AgentTask }>({
    method: 'POST', path: `/tasks/${encodeURIComponent(id)}/transition`, body: { to: STATUS_TO_AGENT[status] }
  })
  return fromAgent(result.task)
}

interface KanbanState {
  tasks: KanbanTask[]
  loading: boolean
  error: string | null
  fetchTasks: () => Promise<void>
  addTask: (request: KanbanAddRequest) => Promise<void>
  updateTask: (request: KanbanUpdateRequest) => Promise<void>
  deleteTask: (id: string) => Promise<void>
  moveTask: (id: string, status: KanbanStatus) => Promise<void>
}

export const useKanbanStore = create<KanbanState>((set, get) => ({
  tasks: [], loading: false, error: null,
  fetchTasks: async () => {
    set({ loading: true, error: null })
    try { set({ tasks: await listTasks(), loading: false }) }
    catch (e) { set({ error: e instanceof Error ? e.message : String(e), loading: false }) }
  },
  addTask: async (request) => {
    set({ loading: true, error: null })
    try {
      const result = await agentManagement<{ task: AgentTask }>({
        method: 'POST', path: '/tasks', body: {
          title: request.title,
          description: request.description ?? '',
          priority: PRIORITY_TO_AGENT[request.priority ?? 'medium'],
          assignee: request.assignee ?? '',
          board_id: 'default',
          metadata: { ...(request.metadata ?? {}), parentId: request.parentId, dependencies: request.dependencies }
        }
      })
      let task = fromAgent(result.task)
      if (request.status && request.status !== 'todo' && request.status !== 'triage') {
        task = await transition(task.id, request.status)
      }
      set({ tasks: [...get().tasks, task], loading: false })
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e), loading: false })
      throw e
    }
  },
  updateTask: async (request) => {
    set({ loading: true, error: null })
    try {
      const current = get().tasks.find((t) => t.id === request.id)
      const body: Record<string, unknown> = {}
      if (request.title !== undefined) body.title = request.title
      if (request.description !== undefined) body.description = request.description
      if (request.priority !== undefined) body.priority = PRIORITY_TO_AGENT[request.priority]
      if (request.assignee !== undefined) body.assignee = request.assignee
      if (request.metadata !== undefined) body.metadata = request.metadata
      const result = await agentManagement<{ task: AgentTask }>({
        method: 'PUT', path: `/tasks/${encodeURIComponent(request.id)}`, body
      })
      let task = fromAgent(result.task)
      if (request.status && request.status !== current?.status) task = await transition(request.id, request.status)
      set({ tasks: get().tasks.map((t) => t.id === request.id ? task : t), loading: false })
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e), loading: false })
      throw e
    }
  },
  deleteTask: async (id) => {
    set({ loading: true, error: null })
    try {
      await agentManagement({ method: 'DELETE', path: `/tasks/${encodeURIComponent(id)}` })
      set({ tasks: get().tasks.filter((t) => t.id !== id), loading: false })
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e), loading: false })
      throw e
    }
  },
  moveTask: async (id, status) => {
    set({ loading: true, error: null })
    try {
      const task = await transition(id, status)
      set({ tasks: get().tasks.map((t) => t.id === id ? task : t), loading: false })
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e), loading: false })
      throw e
    }
  }
}))
