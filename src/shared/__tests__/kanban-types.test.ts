import { describe, it, expect } from 'vitest'
import type {
  KanbanTask,
  KanbanBoard,
  KanbanColumn,
  KanbanListResponse,
  KanbanAddRequest,
  KanbanUpdateRequest,
  KanbanMoveRequest,
  KanbanStatus,
  KanbanPriority
} from '../kanban-types'

describe('Kanban Types', () => {
  it('should define KanbanStatus type with valid values', () => {
    const statuses: KanbanStatus[] = [
      'triage', 'todo', 'scheduled', 'ready', 'running',
      'blocked', 'review', 'done', 'archived'
    ]
    expect(statuses).toHaveLength(9)
    expect(statuses).toContain('todo')
    expect(statuses).toContain('done')
    expect(statuses).toContain('blocked')
  })

  it('should define KanbanPriority type with valid values', () => {
    const priorities: KanbanPriority[] = ['low', 'medium', 'high', 'critical']
    expect(priorities).toHaveLength(4)
    expect(priorities).toContain('medium')
    expect(priorities).toContain('critical')
  })

  it('should define KanbanTask interface', () => {
    const task: KanbanTask = {
      id: 'task-1',
      title: 'Test Task',
      status: 'todo',
      priority: 'medium',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    expect(task).toBeDefined()
    expect(task.id).toBe('task-1')
    expect(task.title).toBe('Test Task')
    expect(task.status).toBe('todo')
    expect(task.priority).toBe('medium')
  })

  it('should define KanbanTask interface with optional fields', () => {
    const task: KanbanTask = {
      id: 'task-2',
      title: 'Full Task',
      description: 'A task with all fields',
      status: 'running',
      priority: 'high',
      assignee: 'user-1',
      parentId: 'task-1',
      dependencies: ['task-0'],
      metadata: { tag: 'feature' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    expect(task.description).toBe('A task with all fields')
    expect(task.assignee).toBe('user-1')
    expect(task.parentId).toBe('task-1')
    expect(task.dependencies).toContain('task-0')
    expect(task.metadata?.tag).toBe('feature')
  })

  it('should define KanbanColumn interface', () => {
    const column: KanbanColumn = {
      id: 'col-1',
      name: 'To Do',
      status: 'todo',
      taskCount: 5
    }
    expect(column).toBeDefined()
    expect(column.id).toBe('col-1')
    expect(column.name).toBe('To Do')
    expect(column.status).toBe('todo')
    expect(column.taskCount).toBe(5)
  })

  it('should define KanbanBoard interface', () => {
    const board: KanbanBoard = {
      id: 'board-1',
      name: 'Test Board',
      columns: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    expect(board).toBeDefined()
    expect(board.id).toBe('board-1')
    expect(board.name).toBe('Test Board')
    expect(board.columns).toEqual([])
  })

  it('should define KanbanBoard with columns and metadata', () => {
    const board: KanbanBoard = {
      id: 'board-2',
      name: 'Full Board',
      columns: [
        { id: 'col-1', name: 'To Do', status: 'todo', taskCount: 3 },
        { id: 'col-2', name: 'In Progress', status: 'running', taskCount: 2 },
        { id: 'col-3', name: 'Done', status: 'done', taskCount: 10 }
      ],
      metadata: { color: 'blue' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    expect(board.columns).toHaveLength(3)
    expect(board.columns[0].name).toBe('To Do')
    expect(board.metadata?.color).toBe('blue')
  })

  it('should define KanbanListResponse interface', () => {
    const response: KanbanListResponse = {
      tasks: [],
      total: 0
    }
    expect(response).toBeDefined()
    expect(response.total).toBe(0)
    expect(response.tasks).toEqual([])
  })

  it('should define KanbanListResponse with tasks', () => {
    const response: KanbanListResponse = {
      tasks: [
        {
          id: 'task-1',
          title: 'Task 1',
          status: 'todo',
          priority: 'low',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ],
      total: 1
    }
    expect(response.tasks).toHaveLength(1)
    expect(response.total).toBe(1)
  })

  it('should define KanbanAddRequest interface', () => {
    const request: KanbanAddRequest = {
      title: 'New Task',
      status: 'todo',
      priority: 'medium'
    }
    expect(request).toBeDefined()
    expect(request.title).toBe('New Task')
    expect(request.status).toBe('todo')
  })

  it('should define KanbanAddRequest with optional fields', () => {
    const request: KanbanAddRequest = {
      title: 'Full Request',
      description: 'Task description',
      status: 'scheduled',
      priority: 'high',
      assignee: 'user-1',
      parentId: 'task-0',
      dependencies: ['task-x'],
      metadata: { source: 'api' }
    }
    expect(request.description).toBe('Task description')
    expect(request.assignee).toBe('user-1')
    expect(request.metadata?.source).toBe('api')
  })

  it('should define KanbanUpdateRequest interface', () => {
    const request: KanbanUpdateRequest = {
      id: 'task-1',
      title: 'Updated Title',
      status: 'review'
    }
    expect(request).toBeDefined()
    expect(request.id).toBe('task-1')
    expect(request.title).toBe('Updated Title')
    expect(request.status).toBe('review')
  })

  it('should define KanbanMoveRequest interface', () => {
    const request: KanbanMoveRequest = {
      id: 'task-1',
      status: 'running'
    }
    expect(request).toBeDefined()
    expect(request.id).toBe('task-1')
    expect(request.status).toBe('running')
  })

  it('should define KanbanMoveRequest with position', () => {
    const request: KanbanMoveRequest = {
      id: 'task-1',
      status: 'done',
      position: 3
    }
    expect(request.position).toBe(3)
  })
})
