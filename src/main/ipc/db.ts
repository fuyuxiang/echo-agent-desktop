import { ipcMain } from 'electron'
import { IpcChannels } from '@shared/ipc-channels'
import {
  addExampleRecord,
  clearExampleRecords,
  listExampleRecords,
  removeExampleRecord
} from '../db/dao/example'

/** 注册数据库 DAO 类 IPC(新增业务表时在此追加) */
export function registerDbHandlers(): void {
  ipcMain.handle(IpcChannels.db.exampleList, () => listExampleRecords())
  ipcMain.handle(IpcChannels.db.exampleAdd, (_e, content: string) => addExampleRecord(content))
  ipcMain.handle(IpcChannels.db.exampleRemove, (_e, id: number) => removeExampleRecord(id))
  ipcMain.handle(IpcChannels.db.exampleClear, () => clearExampleRecords())
}
