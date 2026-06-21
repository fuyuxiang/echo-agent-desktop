import { ipcMain } from 'electron'
import { IpcChannels } from '@shared/ipc-channels'
import {
  addExampleRecord,
  clearExampleRecords,
  listExampleRecords,
  removeExampleRecord
} from '../db/dao/example'
import {
  appendChatMessage,
  deleteChatSession,
  deleteLastAssistantMessage,
  getChatMessages,
  listChatSessions,
  updateChatSessionTitle,
  upsertChatSession
} from '../db/dao/session'

/** 注册数据库 DAO 类 IPC(新增业务表时在此追加) */
export function registerDbHandlers(): void {
  ipcMain.handle(IpcChannels.db.exampleList, () => listExampleRecords())
  ipcMain.handle(IpcChannels.db.exampleAdd, (_e, content: string) => addExampleRecord(content))
  ipcMain.handle(IpcChannels.db.exampleRemove, (_e, id: number) => removeExampleRecord(id))
  ipcMain.handle(IpcChannels.db.exampleClear, () => clearExampleRecords())

  ipcMain.handle(IpcChannels.db.sessionList, () => listChatSessions())
  ipcMain.handle(
    IpcChannels.db.sessionUpsert,
    (_e, input: { chatId: string; title?: string | null; platform?: string }) =>
      upsertChatSession(input)
  )
  ipcMain.handle(IpcChannels.db.sessionDelete, (_e, chatId: string) => deleteChatSession(chatId))
  ipcMain.handle(IpcChannels.db.sessionMessages, (_e, chatId: string) => getChatMessages(chatId))
  ipcMain.handle(
    IpcChannels.db.sessionAppendMessage,
    (_e, input: { chatId: string; role: string; content: string; reasoning?: string | null }) =>
      appendChatMessage(input)
  )
  ipcMain.handle(
    IpcChannels.db.sessionDeleteMessage,
    (_e, chatId: string) => deleteLastAssistantMessage(chatId)
  )
  ipcMain.handle(
    IpcChannels.db.sessionUpdateTitle,
    (_e, chatId: string, title: string) => updateChatSessionTitle(chatId, title)
  )
}
