import { describe, it, expect, vi, beforeEach } from 'vitest'

const { handlers, scheduleService } = vi.hoisted(() => {
  const handlers = new Map<string, (...a: unknown[]) => unknown>()
  const scheduleService = {
    listSchedules: vi.fn(async () => ({
      schedules: [],
      total: 0
    })),
    getSchedule: vi.fn(async (_id: string) => null),
    addSchedule: vi.fn(async (req: unknown) => ({
      id: 'new-id',
      name: 'New Schedule',
      cronExpression: '0 9 * * *',
      isActive: true,
      runCount: 0,
      createdAt: '',
      updatedAt: '',
      ...(req as Record<string, unknown>)
    })),
    updateSchedule: vi.fn(async (req: unknown) => ({ id: 'u-id', ...(req as object) })),
    deleteSchedule: vi.fn(async (_id: string) => undefined),
    toggleSchedule: vi.fn(async (id: string) => ({
      id,
      name: 'Toggled',
      cronExpression: '0 9 * * *',
      isActive: false,
      runCount: 0,
      createdAt: '',
      updatedAt: ''
    })),
    listScheduleLogs: vi.fn(async (_scheduleId: string) => ({
      logs: [],
      total: 0
    })),
    addScheduleLog: vi.fn(async (log: unknown) => ({
      id: 'log-id',
      ...(log as object)
    }))
  }
  return { handlers, scheduleService }
})

vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn) }
}))
vi.mock('../../schedules', () => scheduleService)

import { registerScheduleIpcHandlers } from '../schedules'
import { IpcChannels } from '@shared/ipc-channels'

describe('schedule IPC handlers', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    registerScheduleIpcHandlers()
  })

  function invoke(ch: string, ...args: unknown[]): unknown {
    return handlers.get(ch)!({}, ...args)
  }

  it('registers all eight schedule channels', () => {
    const expected = [
      IpcChannels.schedules.list,
      IpcChannels.schedules.get,
      IpcChannels.schedules.add,
      IpcChannels.schedules.update,
      IpcChannels.schedules.delete,
      IpcChannels.schedules.toggle,
      IpcChannels.schedules.listLogs,
      IpcChannels.schedules.addLog
    ]
    for (const ch of expected) {
      expect(handlers.has(ch), `missing handler for ${ch}`).toBe(true)
    }
  })

  it('schedules:list delegates to listSchedules', async () => {
    const fakeResponse = {
      schedules: [{ id: 's1', name: 'Daily Report', cronExpression: '0 9 * * *', isActive: true, runCount: 0, createdAt: '', updatedAt: '' }],
      total: 1
    }
    scheduleService.listSchedules.mockResolvedValueOnce(fakeResponse as any)
    const result = await invoke(IpcChannels.schedules.list)
    expect(scheduleService.listSchedules).toHaveBeenCalled()
    expect(result).toEqual(fakeResponse)
  })

  it('schedules:get passes id to getSchedule', async () => {
    const fakeSchedule = { id: 's1', name: 'Daily Report', cronExpression: '0 9 * * *', isActive: true, runCount: 0, createdAt: '', updatedAt: '' }
    scheduleService.getSchedule.mockResolvedValueOnce(fakeSchedule as any)
    const result = await invoke(IpcChannels.schedules.get, 's1')
    expect(scheduleService.getSchedule).toHaveBeenCalledWith('s1')
    expect(result).toEqual(fakeSchedule)
  })

  it('schedules:add passes request to addSchedule', async () => {
    const req = { name: 'New Schedule', cronExpression: '0 9 * * *' }
    const created = { id: 'new-id', name: 'New Schedule', cronExpression: '0 9 * * *', isActive: true, runCount: 0, createdAt: '', updatedAt: '' }
    scheduleService.addSchedule.mockResolvedValueOnce(created)
    const result = await invoke(IpcChannels.schedules.add, req)
    expect(scheduleService.addSchedule).toHaveBeenCalledWith(req)
    expect(result).toEqual(created)
  })

  it('schedules:update passes request to updateSchedule', async () => {
    const req = { id: 's1', name: 'Updated Schedule' }
    const updated = { id: 's1', name: 'Updated Schedule', cronExpression: '0 9 * * *', isActive: true, runCount: 0, createdAt: '', updatedAt: '' }
    scheduleService.updateSchedule.mockResolvedValueOnce(updated)
    const result = await invoke(IpcChannels.schedules.update, req)
    expect(scheduleService.updateSchedule).toHaveBeenCalledWith(req)
    expect(result).toEqual(updated)
  })

  it('schedules:delete passes id to deleteSchedule', async () => {
    await invoke(IpcChannels.schedules.delete, 's1')
    expect(scheduleService.deleteSchedule).toHaveBeenCalledWith('s1')
  })

  it('schedules:toggle passes id to toggleSchedule', async () => {
    const toggled = { id: 's1', name: 'Daily Report', cronExpression: '0 9 * * *', isActive: false, runCount: 0, createdAt: '', updatedAt: '' }
    scheduleService.toggleSchedule.mockResolvedValueOnce(toggled)
    const result = await invoke(IpcChannels.schedules.toggle, 's1')
    expect(scheduleService.toggleSchedule).toHaveBeenCalledWith('s1')
    expect(result).toEqual(toggled)
  })

  it('schedules:listLogs passes scheduleId to listScheduleLogs', async () => {
    const logResponse = {
      logs: [{ id: 'l1', scheduleId: 's1', executedAt: '', status: 'success' as const }],
      total: 1
    }
    scheduleService.listScheduleLogs.mockResolvedValueOnce(logResponse as any)
    const result = await invoke(IpcChannels.schedules.listLogs, 's1')
    expect(scheduleService.listScheduleLogs).toHaveBeenCalledWith('s1')
    expect(result).toEqual(logResponse)
  })

  it('schedules:addLog passes log to addScheduleLog', async () => {
    const log = { scheduleId: 's1', executedAt: '2024-01-01', status: 'success' as const }
    const created = { id: 'log-id', ...log }
    scheduleService.addScheduleLog.mockResolvedValueOnce(created)
    const result = await invoke(IpcChannels.schedules.addLog, log)
    expect(scheduleService.addScheduleLog).toHaveBeenCalledWith(log)
    expect(result).toEqual(created)
  })
})
