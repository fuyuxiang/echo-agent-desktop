export interface ScheduleConfig {
  id: string
  name: string
  description?: string
  cronExpression: string
  isActive: boolean
  lastRunAt?: string
  nextRunAt?: string
  runCount: number
  metadata?: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface ScheduleListResponse {
  schedules: ScheduleConfig[]
  total: number
}

export interface ScheduleAddRequest {
  name: string
  description?: string
  cronExpression: string
  metadata?: Record<string, unknown>
}

export interface ScheduleUpdateRequest {
  id: string
  name?: string
  description?: string
  cronExpression?: string
  isActive?: boolean
  metadata?: Record<string, unknown>
}

export interface ScheduleExecutionLog {
  id: string
  scheduleId: string
  executedAt: string
  status: 'success' | 'failure' | 'running'
  duration?: number
  error?: string
  metadata?: Record<string, unknown>
}

export interface ScheduleExecutionLogResponse {
  logs: ScheduleExecutionLog[]
  total: number
}
