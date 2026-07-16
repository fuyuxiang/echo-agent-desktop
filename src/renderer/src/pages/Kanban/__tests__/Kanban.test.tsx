// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KanbanTask } from '@shared/kanban-types'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

// Mock the store
const mockFetchTasks = vi.fn()
const mockAddTask = vi.fn()
const mockUpdateTask = vi.fn()
const mockDeleteTask = vi.fn()
const mockMoveTask = vi.fn()

let mockStoreState = {
  tasks: [] as KanbanTask[],
  loading: false,
  error: null as string | null,
  fetchTasks: mockFetchTasks,
  addTask: mockAddTask,
  updateTask: mockUpdateTask,
  deleteTask: mockDeleteTask,
  moveTask: mockMoveTask
}

vi.mock('@/stores/kanbanStore', () => ({
  useKanbanStore: () => mockStoreState
}))

beforeEach(() => {
  vi.clearAllMocks()
  mockStoreState = {
    tasks: [],
    loading: false,
    error: null,
    fetchTasks: mockFetchTasks,
    addTask: mockAddTask,
    updateTask: mockUpdateTask,
    deleteTask: mockDeleteTask,
    moveTask: mockMoveTask
  }
})

afterEach(() => cleanup())

describe('Kanban Page', () => {
  it('should render kanban page with title', async () => {
    const { default: Kanban } = await import('..')
    render(<Kanban />)
    expect(screen.getByText('kanban.title')).toBeTruthy()
  })

  it('should show add task button', async () => {
    const { default: Kanban } = await import('..')
    render(<Kanban />)
    expect(screen.getByText('kanban.addTask')).toBeTruthy()
  })

  it('should call fetchTasks on mount', async () => {
    const { default: Kanban } = await import('..')
    render(<Kanban />)
    expect(mockFetchTasks).toHaveBeenCalled()
  })

  it('should show loading state', async () => {
    mockStoreState = {
      ...mockStoreState,
      loading: true
    }

    const { default: Kanban } = await import('..')
    render(<Kanban />)
    expect(screen.getByText('kanban.loading')).toBeTruthy()
  })

  it('should show error state', async () => {
    mockStoreState = {
      ...mockStoreState,
      error: 'Failed to fetch tasks'
    }

    const { default: Kanban } = await import('..')
    render(<Kanban />)
    expect(screen.getByText('Failed to fetch tasks')).toBeTruthy()
  })
})

describe('TaskList', () => {
  it('should render empty state when no tasks', async () => {
    const { default: TaskList } = await import('../TaskList')
    render(
      <TaskList
        tasks={[]}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onMove={vi.fn()}
      />
    )
    expect(screen.getByText('kanban.noTasks')).toBeTruthy()
  })

  it('should render task list', async () => {
    const tasks: KanbanTask[] = [
      {
        id: 'task-1',
        title: 'Test Task',
        status: 'todo',
        priority: 'medium',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ]

    const { default: TaskList } = await import('../TaskList')
    render(
      <TaskList
        tasks={tasks}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onMove={vi.fn()}
      />
    )
    expect(screen.getByText('Test Task')).toBeTruthy()
  })
})
