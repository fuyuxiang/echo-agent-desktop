import { ipcMain } from 'electron'
import { IpcChannels } from '@shared/ipc-channels'
import {
  secureDelete,
  secureGet,
  secureSet,
  storeClear,
  storeDelete,
  storeGet,
  storeSet
} from '../store'

/** 注册 KV 存储类 IPC */
export function registerStoreHandlers(): void {
  ipcMain.handle(IpcChannels.store.get, (_e, key: string) => storeGet(key))
  ipcMain.handle(IpcChannels.store.set, (_e, key: string, value: unknown) => storeSet(key, value))
  ipcMain.handle(IpcChannels.store.delete, (_e, key: string) => storeDelete(key))
  ipcMain.handle(IpcChannels.store.clear, () => storeClear())

  ipcMain.handle(IpcChannels.store.secureGet, (_e, key: string) => secureGet(key))
  ipcMain.handle(IpcChannels.store.secureSet, (_e, key: string, value: string) =>
    secureSet(key, value)
  )
  ipcMain.handle(IpcChannels.store.secureDelete, (_e, key: string) => secureDelete(key))
}
