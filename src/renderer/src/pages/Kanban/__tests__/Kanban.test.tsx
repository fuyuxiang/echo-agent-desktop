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

// PromoteDialog 在未接入企业服务器时刻意返回 null(不该弹一个提交后无处可去
// 的对话框),所以测沉淀提示必须先把 org 状态置为已就绪。
const mockOrgStatus = {
  configured: true,
  serverUrl: 'https://echo.test',
  loggedIn: true,
  user: null,
  reachable: true,
  lastSyncAt: Date.now(),
  cachedDocs: 0,
  cachedChunks: 0
}
const mockPromote = vi.fn(async () => ({ ok: true, promotionId: 'p1' }))

vi.mock('@/stores/orgStore', () => ({
  isOrgReady: (s: unknown) => !!s,
  isCacheStale: () => false,
  useOrgStore: (sel?: (s: unknown) => unknown) => {
    const state = {
      status: mockOrgStatus,
      scopes: [{ id: 's_org', kind: 'org', name: '全公司', groupId: null }],
      promote: mockPromote,
      init: vi.fn()
    }
    return sel ? sel(state) : state
  }
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

// 任务刚完成时是回顾解法的最佳时机,过几天细节就忘了。但"反复拖动不重复
// 打扰"这条同样重要 —— 每次拖动都弹窗会让人直接关掉整个功能。
describe('任务完成沉淀提示', () => {
  const task = (over: Partial<KanbanTask> = {}): KanbanTask => ({
    id: 't1',
    title: '修复导入乱码',
    description: '源文件是 GBK,需先转码再入库',
    status: 'running',
    priority: 'medium',
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-01T00:00:00Z',
    ...over
  })

  async function moveTo(status: KanbanTask['status'], from: KanbanTask['status']) {
    mockStoreState.tasks = [task({ status: from })]
    const { default: KanbanPage } = await import('../index')
    render(<KanbanPage />)
    const select = screen.getAllByRole('combobox')[0]
    const { fireEvent } = await import('@testing-library/react')
    fireEvent.change(select, { target: { value: status } })
    return screen
  }

  it('首次进入 done 时弹出沉淀对话框', async () => {
    const s = await moveTo('done', 'review')
    expect(mockMoveTask).toHaveBeenCalledWith('t1', 'done')
    // i18n mock:t(key) = key,PromoteDialog 标题对应 promote.title
    expect(await s.findByText('promote.title')).toBeTruthy()
  })

  it('预填任务标题与说明', async () => {
    const s = await moveTo('done', 'review')
    await s.findByText('promote.title')
    const area = s.getAllByRole('textbox')[0] as HTMLTextAreaElement
    expect(area.value).toContain('修复导入乱码')
    expect(area.value).toContain('GBK')
  })

  it('已是 done 再拖动不重复提示', async () => {
    const s = await moveTo('done', 'done')
    expect(mockMoveTask).toHaveBeenCalled()
    expect(s.queryByText('promote.title')).toBeNull()
  })

  it('移到非 done 状态不提示', async () => {
    const s = await moveTo('review', 'running')
    expect(s.queryByText('promote.title')).toBeNull()
  })
})
