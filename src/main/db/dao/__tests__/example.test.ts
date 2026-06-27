import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../migrations'

let memDb: Database.Database

vi.mock('../../index', () => ({
  getDb: () => memDb
}))

import {
  addExampleRecord,
  clearExampleRecords,
  listExampleRecords,
  removeExampleRecord
} from '../example'

beforeEach(() => {
  memDb = new Database(':memory:')
  runMigrations(memDb)
})

afterEach(() => {
  vi.restoreAllMocks()
  memDb.close()
})

describe('example DAO', () => {
  it('新增、倒序查询、删除和清空示例记录', () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(100).mockReturnValueOnce(200)
    const first = addExampleRecord('first')
    const second = addExampleRecord('second')

    expect(first).toMatchObject({ content: 'first', createdAt: 100 })
    expect(second).toMatchObject({ content: 'second', createdAt: 200 })
    expect(listExampleRecords()).toEqual([second, first])

    removeExampleRecord(second.id)
    expect(listExampleRecords()).toEqual([first])

    clearExampleRecords()
    expect(listExampleRecords()).toEqual([])
  })
})
