import { randomUUID } from 'crypto'
import type {
  ScheduleConfig,
  ScheduleListResponse,
  ScheduleAddRequest,
  ScheduleUpdateRequest,
  ScheduleExecutionLog,
  ScheduleExecutionLogResponse
} from '../shared/schedule-types'
import { storeGet, storeSet } from './store'

const SCHEDULES_KEY = 'schedules.schedules'
const LOGS_KEY = 'schedules.logs'

/** 读取定时任务列表 */
function getSchedules(): ScheduleConfig[] {
  return storeGet<ScheduleConfig[]>(SCHEDULES_KEY) ?? []
}

/** 读取执行日志列表 */
function getLogs(): ScheduleExecutionLog[] {
  return storeGet<ScheduleExecutionLog[]>(LOGS_KEY) ?? []
}

/** 列出所有定时任务 */
export async function listSchedules(): Promise<ScheduleListResponse> {
  const schedules = getSchedules()
  return {
    schedules,
    total: schedules.length
  }
}

/** 按 ID 获取单个定时任务 */
export async function getSchedule(id: string): Promise<ScheduleConfig | null> {
  const schedules = getSchedules()
  return schedules.find(s => s.id === id) || null
}

/** 添加新定时任务 */
export async function addSchedule(request: ScheduleAddRequest): Promise<ScheduleConfig> {
  const schedules = getSchedules()
  const now = new Date().toISOString()

  const newSchedule: ScheduleConfig = {
    id: randomUUID(),
    name: request.name,
    description: request.description,
    cronExpression: request.cronExpression,
    isActive: true,
    runCount: 0,
    metadata: request.metadata,
    createdAt: now,
    updatedAt: now
  }

  schedules.push(newSchedule)
  storeSet(SCHEDULES_KEY, schedules)
  return newSchedule
}

/** 更新定时任务 */
export async function updateSchedule(request: ScheduleUpdateRequest): Promise<ScheduleConfig> {
  const schedules = getSchedules()
  const index = schedules.findIndex(s => s.id === request.id)
  if (index === -1) {
    throw new Error(`Schedule not found: ${request.id}`)
  }

  const updated: ScheduleConfig = {
    ...schedules[index],
    ...request,
    updatedAt: new Date().toISOString()
  }
  schedules[index] = updated
  storeSet(SCHEDULES_KEY, schedules)
  return updated
}

/** 删除定时任务及其关联日志 */
export async function deleteSchedule(id: string): Promise<void> {
  const schedules = getSchedules()
  const filtered = schedules.filter(s => s.id !== id)
  storeSet(SCHEDULES_KEY, filtered)

  // 同时删除该任务的执行日志
  const logs = getLogs()
  const filteredLogs = logs.filter(l => l.scheduleId !== id)
  storeSet(LOGS_KEY, filteredLogs)
}

/** 切换定时任务启用状态 */
export async function toggleSchedule(id: string): Promise<ScheduleConfig> {
  const schedules = getSchedules()
  const index = schedules.findIndex(s => s.id === id)
  if (index === -1) {
    throw new Error(`Schedule not found: ${id}`)
  }

  const updated: ScheduleConfig = {
    ...schedules[index],
    isActive: !schedules[index].isActive,
    updatedAt: new Date().toISOString()
  }
  schedules[index] = updated
  storeSet(SCHEDULES_KEY, schedules)
  return updated
}

/** 查询指定定时任务的执行日志 */
export async function listScheduleLogs(scheduleId: string): Promise<ScheduleExecutionLogResponse> {
  const logs = getLogs().filter(l => l.scheduleId === scheduleId)
  return {
    logs,
    total: logs.length
  }
}

/** 添加执行日志 */
export async function addScheduleLog(log: Omit<ScheduleExecutionLog, 'id'>): Promise<ScheduleExecutionLog> {
  const logs = getLogs()
  const newLog: ScheduleExecutionLog = {
    ...log,
    id: randomUUID()
  }

  logs.push(newLog)
  storeSet(LOGS_KEY, logs)

  // 更新任务的运行次数和最后运行时间
  const schedules = getSchedules()
  const index = schedules.findIndex(s => s.id === log.scheduleId)
  if (index !== -1) {
    schedules[index] = {
      ...schedules[index],
      runCount: schedules[index].runCount + 1,
      lastRunAt: log.executedAt,
      updatedAt: new Date().toISOString()
    }
    storeSet(SCHEDULES_KEY, schedules)
  }

  return newLog
}
