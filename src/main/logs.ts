import { storeGet, storeSet } from './store'
import { randomUUID } from 'crypto'
import type { LogEntry, LogListResponse, LogQueryRequest, LogLevel } from '../shared/settings-types'

const LOGS_KEY = 'settings.logs'
const MAX_LOGS = 1000

function getLogs(): LogEntry[] {
  return storeGet(LOGS_KEY) ?? []
}

export async function listLogs(request?: LogQueryRequest): Promise<LogListResponse> {
  let logs = getLogs()

  // Filter by level
  if (request?.level) {
    logs = logs.filter((log) => log.level === request.level)
  }

  // Filter by time range
  if (request?.startTime) {
    logs = logs.filter((log) => log.timestamp >= request.startTime!)
  }
  if (request?.endTime) {
    logs = logs.filter((log) => log.timestamp <= request.endTime!)
  }

  // Sort by timestamp (newest first)
  logs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())

  // Apply pagination
  const offset = request?.offset || 0
  const limit = request?.limit || 100
  const paginatedLogs = logs.slice(offset, offset + limit)

  return {
    logs: paginatedLogs,
    total: logs.length
  }
}

export async function addLog(level: LogLevel, message: string, metadata?: Record<string, unknown>): Promise<LogEntry> {
  const logs = getLogs()

  const newLog: LogEntry = {
    id: randomUUID(),
    level,
    message,
    timestamp: new Date().toISOString(),
    metadata
  }

  logs.push(newLog)

  // Trim logs if exceeding max
  if (logs.length > MAX_LOGS) {
    logs.splice(0, logs.length - MAX_LOGS)
  }

  storeSet(LOGS_KEY, logs)
  return newLog
}

export async function clearLogs(): Promise<void> {
  storeSet(LOGS_KEY, [])
}

export async function getLogById(id: string): Promise<LogEntry | null> {
  const logs = getLogs()
  return logs.find((log) => log.id === id) || null
}

export async function deleteLog(id: string): Promise<void> {
  const logs = getLogs()
  const filtered = logs.filter((log) => log.id !== id)
  storeSet(LOGS_KEY, filtered)
}

export async function getLogStats(): Promise<{
  total: number
  byLevel: Record<LogLevel, number>
}> {
  const logs = getLogs()
  const byLevel: Record<LogLevel, number> = {
    debug: 0,
    info: 0,
    warn: 0,
    error: 0
  }

  logs.forEach((log) => {
    byLevel[log.level]++
  })

  return {
    total: logs.length,
    byLevel
  }
}
