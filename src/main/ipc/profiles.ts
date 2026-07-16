import { ipcMain } from 'electron'
import { IpcChannels } from '@shared/ipc-channels'
import {
  listProfiles,
  getProfile,
  addProfile,
  updateProfile,
  deleteProfile,
  setActiveProfile,
  exportProfile,
  importProfile
} from '../profiles'
import type { ProfileAddRequest, ProfileUpdateRequest, ProfileImportData } from '../../shared/profile-types'

/** 注册 profiles:* IPC handler */
export function registerProfileIpcHandlers(): void {
  ipcMain.handle(IpcChannels.profiles.list, () => listProfiles())

  ipcMain.handle(IpcChannels.profiles.get, (_e, id: string) => getProfile(id))

  ipcMain.handle(IpcChannels.profiles.add, (_e, request: ProfileAddRequest) => addProfile(request))

  ipcMain.handle(IpcChannels.profiles.update, (_e, request: ProfileUpdateRequest) =>
    updateProfile(request)
  )

  ipcMain.handle(IpcChannels.profiles.delete, (_e, id: string) => deleteProfile(id))

  ipcMain.handle(IpcChannels.profiles.setActive, (_e, id: string) => setActiveProfile(id))

  ipcMain.handle(IpcChannels.profiles.export, (_e, id: string) => exportProfile(id))

  ipcMain.handle(IpcChannels.profiles.import, (_e, data: ProfileImportData) => importProfile(data))
}
