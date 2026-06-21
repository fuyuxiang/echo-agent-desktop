import type { ExampleRecord } from '@shared/types'
import { getDb } from '../index'

/**
 * 示例 DAO(配合 pages/Example 演示数据库全链路)
 *
 * 新增业务表时依葫芦画瓢:
 * 1. migrations.ts 加迁移建表
 * 2. dao/ 下新建 xxx.ts 写增删改查
 * 3. ipc/db.ts 注册 handler
 * 4. shared/types/api.ts 补类型,preload 桥接
 * 5. 渲染层 utils/db.ts 暴露门面方法
 */

/** 行记录 -> 业务类型映射 */
interface ExampleRow {
  id: number
  content: string
  created_at: number
}

function toRecord(row: ExampleRow): ExampleRecord {
  return { id: row.id, content: row.content, createdAt: row.created_at }
}

/** 查询全部记录(按创建时间倒序) */
export function listExampleRecords(): ExampleRecord[] {
  const rows = getDb()
    .prepare('SELECT * FROM example_records ORDER BY created_at DESC')
    .all() as ExampleRow[]
  return rows.map(toRecord)
}

/** 新增一条记录,返回完整记录 */
export function addExampleRecord(content: string): ExampleRecord {
  const createdAt = Date.now()
  const result = getDb()
    .prepare('INSERT INTO example_records (content, created_at) VALUES (?, ?)')
    .run(content, createdAt)
  return { id: Number(result.lastInsertRowid), content, createdAt }
}

/** 删除指定记录 */
export function removeExampleRecord(id: number): void {
  getDb().prepare('DELETE FROM example_records WHERE id = ?').run(id)
}

/** 清空示例表 */
export function clearExampleRecords(): void {
  getDb().prepare('DELETE FROM example_records').run()
}
