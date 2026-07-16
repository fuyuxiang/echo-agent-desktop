import { ipcMain } from 'electron'
import { IpcChannels } from '@shared/ipc-channels'
import {
  listSchedules,
  getSchedule,
  addSchedule,
  updateSchedule,
  deleteSchedule,
  toggleSchedule,
  listScheduleLogs,
  addScheduleLog
} from '../schedules'
import type { ScheduleAddRequest, ScheduleUpdateRequest, ScheduleExecutionLog } from '../../shared/schedule-types'

/** 注册 schedules:* IPC handler */
export function registerScheduleIpcHandlers(): void {
  ipcMain.handle(IpcChannels.schedules.list, () => listSchedules())

  ipcMain.handle(IpcChannels.schedules.get, (_e, id: string) => getSchedule(id))

  ipcMain.handle(IpcChannels.schedules.add, (_e, request: ScheduleAddRequest) => addSchedule(request))

  ipcMain.handle(IpcChannels.schedules.update, (_e, request: ScheduleUpdateRequest) =>
    updateSchedule(request)
  )

  ipcMain.handle(IpcChannels.schedules.delete, (_e, id: string) => deleteSchedule(id))

  ipcMain.handle(IpcChannels.schedules.toggle, (_e, id: string) => toggleSchedule(id))

  ipcMain.handle(IpcChannels.schedules.listLogs, (_e, scheduleId: string) => listScheduleLogs(scheduleId))

  ipcMain.handle(IpcChannels.schedules.addLog, (_e, log: Omit<ScheduleExecutionLog, 'id'>) => addScheduleLog(log))
}
