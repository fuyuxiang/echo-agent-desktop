import { randomUUID } from 'crypto'
import type {
  KanbanTask,
  KanbanBoard,
  KanbanListResponse,
  KanbanAddRequest,
  KanbanUpdateRequest,
  KanbanMoveRequest
} from '../shared/kanban-types'
import { storeGet, storeSet } from './store'

const TASKS_KEY = 'kanban.tasks'
const BOARDS_KEY = 'kanban.boards'

/** Read tasks from store */
function getTasks(): KanbanTask[] {
  return storeGet<KanbanTask[]>(TASKS_KEY) ?? []
}

/** Read boards from store */
function getBoards(): KanbanBoard[] {
  return storeGet<KanbanBoard[]>(BOARDS_KEY) ?? []
}

/** List all kanban tasks */
export async function listTasks(): Promise<KanbanListResponse> {
  const tasks = getTasks()
  return {
    tasks,
    total: tasks.length
  }
}

/** Get a kanban task by id */
export async function getTask(id: string): Promise<KanbanTask> {
  const tasks = getTasks()
  const task = tasks.find(t => t.id === id)
  if (!task) {
    throw new Error(`Task not found: ${id}`)
  }
  return task
}

/** Add a new kanban task */
export async function addTask(request: KanbanAddRequest): Promise<KanbanTask> {
  const tasks = getTasks()
  const now = new Date().toISOString()
  const newTask: KanbanTask = {
    id: randomUUID(),
    title: request.title,
    description: request.description,
    status: request.status ?? 'todo',
    priority: request.priority ?? 'medium',
    assignee: request.assignee,
    parentId: request.parentId,
    dependencies: request.dependencies,
    metadata: request.metadata,
    createdAt: now,
    updatedAt: now
  }
  tasks.push(newTask)
  storeSet(TASKS_KEY, tasks)
  return newTask
}

/** Update an existing kanban task */
export async function updateTask(request: KanbanUpdateRequest): Promise<KanbanTask> {
  const tasks = getTasks()
  const index = tasks.findIndex(t => t.id === request.id)
  if (index === -1) {
    throw new Error(`Task not found: ${request.id}`)
  }
  const updated: KanbanTask = {
    ...tasks[index],
    ...request,
    updatedAt: new Date().toISOString()
  }
  tasks[index] = updated
  storeSet(TASKS_KEY, tasks)
  return updated
}

/** Delete a kanban task by id */
export async function deleteTask(id: string): Promise<void> {
  const tasks = getTasks()
  const filtered = tasks.filter(t => t.id !== id)
  storeSet(TASKS_KEY, filtered)
}

/** Move a kanban task to a new status/position */
export async function moveTask(request: KanbanMoveRequest): Promise<KanbanTask> {
  const tasks = getTasks()
  const index = tasks.findIndex(t => t.id === request.id)
  if (index === -1) {
    throw new Error(`Task not found: ${request.id}`)
  }
  const updated: KanbanTask = {
    ...tasks[index],
    status: request.status,
    updatedAt: new Date().toISOString()
  }
  tasks[index] = updated
  storeSet(TASKS_KEY, tasks)
  return updated
}

/** List all kanban boards */
export async function listBoards(): Promise<KanbanBoard[]> {
  return getBoards()
}

/** Get a kanban board by id */
export async function getBoard(id: string): Promise<KanbanBoard> {
  const boards = getBoards()
  const board = boards.find(b => b.id === id)
  if (!board) {
    throw new Error(`Board not found: ${id}`)
  }
  return board
}

/** Add a new kanban board */
export async function addBoard(request: { name: string; metadata?: Record<string, unknown> }): Promise<KanbanBoard> {
  const boards = getBoards()
  const now = new Date().toISOString()
  const newBoard: KanbanBoard = {
    id: randomUUID(),
    name: request.name,
    columns: [
      { id: randomUUID(), name: 'Triage', status: 'triage', taskCount: 0 },
      { id: randomUUID(), name: 'To Do', status: 'todo', taskCount: 0 },
      { id: randomUUID(), name: 'Scheduled', status: 'scheduled', taskCount: 0 },
      { id: randomUUID(), name: 'Ready', status: 'ready', taskCount: 0 },
      { id: randomUUID(), name: 'Running', status: 'running', taskCount: 0 },
      { id: randomUUID(), name: 'Blocked', status: 'blocked', taskCount: 0 },
      { id: randomUUID(), name: 'Review', status: 'review', taskCount: 0 },
      { id: randomUUID(), name: 'Done', status: 'done', taskCount: 0 },
      { id: randomUUID(), name: 'Archived', status: 'archived', taskCount: 0 }
    ],
    metadata: request.metadata,
    createdAt: now,
    updatedAt: now
  }
  boards.push(newBoard)
  storeSet(BOARDS_KEY, boards)
  return newBoard
}

/** Update an existing kanban board */
export async function updateBoard(request: { id: string; name?: string; metadata?: Record<string, unknown> }): Promise<KanbanBoard> {
  const boards = getBoards()
  const index = boards.findIndex(b => b.id === request.id)
  if (index === -1) {
    throw new Error(`Board not found: ${request.id}`)
  }
  const updated: KanbanBoard = {
    ...boards[index],
    ...request,
    updatedAt: new Date().toISOString()
  }
  boards[index] = updated
  storeSet(BOARDS_KEY, boards)
  return updated
}

/** Delete a kanban board by id */
export async function deleteBoard(id: string): Promise<void> {
  const boards = getBoards()
  const filtered = boards.filter(b => b.id !== id)
  storeSet(BOARDS_KEY, filtered)
}
