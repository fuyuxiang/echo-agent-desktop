export type KanbanStatus =
  | 'triage'
  | 'todo'
  | 'scheduled'
  | 'ready'
  | 'running'
  | 'blocked'
  | 'review'
  | 'done'
  | 'archived'

export type KanbanPriority = 'low' | 'medium' | 'high' | 'critical'

export interface KanbanTask {
  id: string
  title: string
  description?: string
  status: KanbanStatus
  priority: KanbanPriority
  assignee?: string
  parentId?: string
  dependencies?: string[]
  metadata?: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface KanbanColumn {
  id: string
  name: string
  status: KanbanStatus
  taskCount: number
}

export interface KanbanBoard {
  id: string
  name: string
  columns: KanbanColumn[]
  metadata?: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface KanbanListResponse {
  tasks: KanbanTask[]
  total: number
}

export interface KanbanAddRequest {
  title: string
  description?: string
  status?: KanbanStatus
  priority?: KanbanPriority
  assignee?: string
  parentId?: string
  dependencies?: string[]
  metadata?: Record<string, unknown>
}

export interface KanbanUpdateRequest {
  id: string
  title?: string
  description?: string
  status?: KanbanStatus
  priority?: KanbanPriority
  assignee?: string
  parentId?: string
  dependencies?: string[]
  metadata?: Record<string, unknown>
}

export interface KanbanMoveRequest {
  id: string
  status: KanbanStatus
  position?: number
}
