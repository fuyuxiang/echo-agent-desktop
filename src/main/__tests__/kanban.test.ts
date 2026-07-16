import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock the store module
vi.mock('../store', () => ({
  storeGet: vi.fn(),
  storeSet: vi.fn()
}))

import {
  listTasks,
  getTask,
  addTask,
  updateTask,
  deleteTask,
  moveTask,
  listBoards,
  getBoard,
  addBoard,
  updateBoard,
  deleteBoard
} from '../kanban'
import { storeGet, storeSet } from '../store'

const mockStoreGet = vi.mocked(storeGet)
const mockStoreSet = vi.mocked(storeSet)

describe('Kanban Management Service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockStoreGet.mockReturnValue([])
  })

  describe('listTasks', () => {
    it('should return empty list when no tasks', async () => {
      const result = await listTasks()
      expect(result).toEqual({ tasks: [], total: 0 })
    })

    it('should return added tasks', async () => {
      const task = await addTask({ title: 'Test Task' })
      mockStoreGet.mockReturnValue([task])
      const result = await listTasks()
      expect(result.tasks).toHaveLength(1)
      expect(result.total).toBe(1)
    })
  })

  describe('getTask', () => {
    it('should throw for non-existent task', async () => {
      await expect(getTask('non-existent')).rejects.toThrow('Task not found: non-existent')
    })

    it('should return existing task', async () => {
      const task = await addTask({ title: 'Test Task' })
      mockStoreGet.mockReturnValue([task])
      const result = await getTask(task.id)
      expect(result.title).toBe('Test Task')
    })
  })

  describe('addTask', () => {
    it('should add a new task', async () => {
      const result = await addTask({ title: 'New Task' })
      expect(result.title).toBe('New Task')
      expect(result.status).toBe('todo')
      expect(result.priority).toBe('medium')
      expect(mockStoreSet).toHaveBeenCalled()
    })

    it('should add task with custom status and priority', async () => {
      const result = await addTask({
        title: 'Custom Task',
        status: 'running',
        priority: 'high'
      })
      expect(result.status).toBe('running')
      expect(result.priority).toBe('high')
    })

    it('should add task with optional fields', async () => {
      const result = await addTask({
        title: 'Full Task',
        description: 'Task description',
        assignee: 'user1',
        parentId: 'parent1',
        dependencies: ['dep1'],
        metadata: { key: 'value' }
      })
      expect(result.description).toBe('Task description')
      expect(result.assignee).toBe('user1')
      expect(result.parentId).toBe('parent1')
      expect(result.dependencies).toEqual(['dep1'])
      expect(result.metadata).toEqual({ key: 'value' })
    })
  })

  describe('updateTask', () => {
    it('should throw for non-existent task', async () => {
      await expect(updateTask({ id: 'non-existent', title: 'Updated' })).rejects.toThrow('Task not found: non-existent')
    })

    it('should update an existing task', async () => {
      const task = await addTask({ title: 'Original' })
      mockStoreGet.mockReturnValue([task])
      const result = await updateTask({ id: task.id, title: 'Updated' })
      expect(result.title).toBe('Updated')
      expect(mockStoreSet).toHaveBeenCalled()
    })

    it('should update task status', async () => {
      const task = await addTask({ title: 'Task' })
      mockStoreGet.mockReturnValue([task])
      const result = await updateTask({ id: task.id, status: 'done' })
      expect(result.status).toBe('done')
    })
  })

  describe('deleteTask', () => {
    it('should delete an existing task', async () => {
      const task = await addTask({ title: 'To Delete' })
      mockStoreGet.mockReturnValue([task])
      await deleteTask(task.id)
      expect(mockStoreSet).toHaveBeenCalledWith('kanban.tasks', [])
    })

    it('should not throw when deleting non-existent task', async () => {
      await expect(deleteTask('non-existent')).resolves.not.toThrow()
    })
  })

  describe('moveTask', () => {
    it('should throw for non-existent task', async () => {
      await expect(moveTask({ id: 'non-existent', status: 'done' })).rejects.toThrow('Task not found: non-existent')
    })

    it('should move task to new status', async () => {
      const task = await addTask({ title: 'Task' })
      mockStoreGet.mockReturnValue([task])
      const result = await moveTask({ id: task.id, status: 'review' })
      expect(result.status).toBe('review')
    })
  })

  describe('listBoards', () => {
    it('should return empty list when no boards', async () => {
      const result = await listBoards()
      expect(result).toEqual([])
    })

    it('should return added boards', async () => {
      const board = await addBoard({ name: 'Test Board' })
      mockStoreGet.mockReturnValue([board])
      const result = await listBoards()
      expect(result).toHaveLength(1)
    })
  })

  describe('getBoard', () => {
    it('should throw for non-existent board', async () => {
      await expect(getBoard('non-existent')).rejects.toThrow('Board not found: non-existent')
    })

    it('should return existing board', async () => {
      const board = await addBoard({ name: 'Test Board' })
      mockStoreGet.mockReturnValue([board])
      const result = await getBoard(board.id)
      expect(result.name).toBe('Test Board')
    })
  })

  describe('addBoard', () => {
    it('should add a new board', async () => {
      const result = await addBoard({ name: 'New Board' })
      expect(result.name).toBe('New Board')
      expect(result.columns).toHaveLength(9)
      expect(mockStoreSet).toHaveBeenCalled()
    })

    it('should add board with metadata', async () => {
      const result = await addBoard({
        name: 'Board with Metadata',
        metadata: { key: 'value' }
      })
      expect(result.metadata).toEqual({ key: 'value' })
    })
  })

  describe('updateBoard', () => {
    it('should throw for non-existent board', async () => {
      await expect(updateBoard({ id: 'non-existent', name: 'Updated' })).rejects.toThrow('Board not found: non-existent')
    })

    it('should update an existing board', async () => {
      const board = await addBoard({ name: 'Original' })
      mockStoreGet.mockReturnValue([board])
      const result = await updateBoard({ id: board.id, name: 'Updated' })
      expect(result.name).toBe('Updated')
      expect(mockStoreSet).toHaveBeenCalled()
    })
  })

  describe('deleteBoard', () => {
    it('should delete an existing board', async () => {
      const board = await addBoard({ name: 'To Delete' })
      mockStoreGet.mockReturnValue([board])
      await deleteBoard(board.id)
      expect(mockStoreSet).toHaveBeenCalledWith('kanban.boards', [])
    })

    it('should not throw when deleting non-existent board', async () => {
      await expect(deleteBoard('non-existent')).resolves.not.toThrow()
    })
  })
})
