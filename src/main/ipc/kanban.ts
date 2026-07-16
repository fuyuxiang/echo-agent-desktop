import { ipcMain } from 'electron'
import { IpcChannels } from '@shared/ipc-channels'
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
import type {
  KanbanAddRequest,
  KanbanUpdateRequest,
  KanbanMoveRequest
} from '../../shared/kanban-types'

/** 注册 kanban:* IPC handler */
export function registerKanbanIpcHandlers(): void {
  ipcMain.handle(IpcChannels.kanban.listTasks, () => listTasks())

  ipcMain.handle(IpcChannels.kanban.getTask, (_e, id: string) => getTask(id))

  ipcMain.handle(IpcChannels.kanban.addTask, (_e, request: KanbanAddRequest) => addTask(request))

  ipcMain.handle(IpcChannels.kanban.updateTask, (_e, request: KanbanUpdateRequest) =>
    updateTask(request)
  )

  ipcMain.handle(IpcChannels.kanban.deleteTask, (_e, id: string) => deleteTask(id))

  ipcMain.handle(IpcChannels.kanban.moveTask, (_e, request: KanbanMoveRequest) =>
    moveTask(request)
  )

  ipcMain.handle(IpcChannels.kanban.listBoards, () => listBoards())

  ipcMain.handle(IpcChannels.kanban.getBoard, (_e, id: string) => getBoard(id))

  ipcMain.handle(IpcChannels.kanban.addBoard, (_e, request: { name: string; metadata?: Record<string, unknown> }) =>
    addBoard(request)
  )

  ipcMain.handle(IpcChannels.kanban.updateBoard, (_e, request: { id: string; name?: string; metadata?: Record<string, unknown> }) =>
    updateBoard(request)
  )

  ipcMain.handle(IpcChannels.kanban.deleteBoard, (_e, id: string) => deleteBoard(id))
}
