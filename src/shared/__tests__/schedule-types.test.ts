import { describe, it, expect } from 'vitest'
import type {
  ScheduleConfig,
  ScheduleListResponse,
  ScheduleAddRequest,
  ScheduleUpdateRequest,
  ScheduleExecutionLog,
  ScheduleExecutionLogResponse
} from '../schedule-types'

describe('Schedule Types', () => {
  it('should define ScheduleConfig interface', () => {
    const schedule: ScheduleConfig = {
      id: 'schedule-1',
      name: 'Daily Report',
      cronExpression: '0 9 * * *',
      isActive: true,
      runCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    expect(schedule).toBeDefined()
    expect(schedule.id).toBe('schedule-1')
    expect(schedule.name).toBe('Daily Report')
    expect(schedule.cronExpression).toBe('0 9 * * *')
    expect(schedule.isActive).toBe(true)
    expect(schedule.runCount).toBe(0)
  })

  it('should support optional fields in ScheduleConfig', () => {
    const schedule: ScheduleConfig = {
      id: 'schedule-2',
      name: 'Weekly Cleanup',
      description: 'Clean up temporary files every week',
      cronExpression: '0 0 * * 0',
      isActive: false,
      lastRunAt: '2026-07-15T00:00:00Z',
      nextRunAt: '2026-07-22T00:00:00Z',
      runCount: 5,
      metadata: { priority: 'low', tags: ['maintenance'] },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    expect(schedule.description).toBe('Clean up temporary files every week')
    expect(schedule.lastRunAt).toBe('2026-07-15T00:00:00Z')
    expect(schedule.nextRunAt).toBe('2026-07-22T00:00:00Z')
    expect(schedule.runCount).toBe(5)
    expect(schedule.metadata?.priority).toBe('low')
    expect(schedule.metadata?.tags).toEqual(['maintenance'])
  })

  it('should define ScheduleListResponse interface', () => {
    const response: ScheduleListResponse = {
      schedules: [],
      total: 0
    }
    expect(response).toBeDefined()
    expect(response.total).toBe(0)
    expect(response.schedules).toEqual([])
  })

  it('should support populated ScheduleListResponse', () => {
    const response: ScheduleListResponse = {
      schedules: [
        {
          id: 'schedule-1',
          name: 'Daily Report',
          cronExpression: '0 9 * * *',
          isActive: true,
          runCount: 10,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ],
      total: 1
    }
    expect(response.schedules).toHaveLength(1)
    expect(response.total).toBe(1)
    expect(response.schedules[0].name).toBe('Daily Report')
  })

  it('should define ScheduleAddRequest interface', () => {
    const request: ScheduleAddRequest = {
      name: 'New Schedule',
      cronExpression: '30 8 * * 1-5'
    }
    expect(request).toBeDefined()
    expect(request.name).toBe('New Schedule')
    expect(request.cronExpression).toBe('30 8 * * 1-5')
    expect(request.description).toBeUndefined()
    expect(request.metadata).toBeUndefined()
  })

  it('should support all optional fields in ScheduleAddRequest', () => {
    const request: ScheduleAddRequest = {
      name: 'Full Schedule',
      description: 'A complete schedule request',
      cronExpression: '0 */6 * * *',
      metadata: { category: 'reports' }
    }
    expect(request.description).toBe('A complete schedule request')
    expect(request.metadata?.category).toBe('reports')
  })

  it('should define ScheduleUpdateRequest interface', () => {
    const request: ScheduleUpdateRequest = {
      id: 'schedule-1'
    }
    expect(request).toBeDefined()
    expect(request.id).toBe('schedule-1')
    expect(request.name).toBeUndefined()
    expect(request.description).toBeUndefined()
    expect(request.cronExpression).toBeUndefined()
    expect(request.isActive).toBeUndefined()
    expect(request.metadata).toBeUndefined()
  })

  it('should support partial updates in ScheduleUpdateRequest', () => {
    const request: ScheduleUpdateRequest = {
      id: 'schedule-1',
      name: 'Updated Schedule',
      isActive: false
    }
    expect(request.id).toBe('schedule-1')
    expect(request.name).toBe('Updated Schedule')
    expect(request.isActive).toBe(false)
  })

  it('should define ScheduleExecutionLog interface', () => {
    const log: ScheduleExecutionLog = {
      id: 'log-1',
      scheduleId: 'schedule-1',
      executedAt: new Date().toISOString(),
      status: 'success'
    }
    expect(log).toBeDefined()
    expect(log.id).toBe('log-1')
    expect(log.scheduleId).toBe('schedule-1')
    expect(log.status).toBe('success')
  })

  it('should support all status values in ScheduleExecutionLog', () => {
    const successLog: ScheduleExecutionLog = {
      id: 'log-1',
      scheduleId: 'schedule-1',
      executedAt: new Date().toISOString(),
      status: 'success',
      duration: 1500
    }
    const failureLog: ScheduleExecutionLog = {
      id: 'log-2',
      scheduleId: 'schedule-1',
      executedAt: new Date().toISOString(),
      status: 'failure',
      duration: 500,
      error: 'Connection timeout'
    }
    const runningLog: ScheduleExecutionLog = {
      id: 'log-3',
      scheduleId: 'schedule-1',
      executedAt: new Date().toISOString(),
      status: 'running'
    }
    expect(successLog.status).toBe('success')
    expect(successLog.duration).toBe(1500)
    expect(failureLog.status).toBe('failure')
    expect(failureLog.error).toBe('Connection timeout')
    expect(runningLog.status).toBe('running')
  })

  it('should support optional fields in ScheduleExecutionLog', () => {
    const log: ScheduleExecutionLog = {
      id: 'log-1',
      scheduleId: 'schedule-1',
      executedAt: new Date().toISOString(),
      status: 'success',
      duration: 2000,
      metadata: { outputLines: 42 }
    }
    expect(log.duration).toBe(2000)
    expect(log.metadata?.outputLines).toBe(42)
  })

  it('should define ScheduleExecutionLogResponse interface', () => {
    const response: ScheduleExecutionLogResponse = {
      logs: [],
      total: 0
    }
    expect(response).toBeDefined()
    expect(response.logs).toEqual([])
    expect(response.total).toBe(0)
  })

  it('should support populated ScheduleExecutionLogResponse', () => {
    const response: ScheduleExecutionLogResponse = {
      logs: [
        {
          id: 'log-1',
          scheduleId: 'schedule-1',
          executedAt: new Date().toISOString(),
          status: 'success',
          duration: 1000
        }
      ],
      total: 1
    }
    expect(response.logs).toHaveLength(1)
    expect(response.total).toBe(1)
  })
})
