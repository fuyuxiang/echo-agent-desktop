import type { ExampleRecord } from '@shared/types'

/**
 * 本地数据库门面(底层主进程 better-sqlite3)
 *
 * 用法:
 *   const list = await db.example.list()
 *   await db.example.add('一条记录')
 *
 * 新增业务表流程见 src/main/db/dao/example.ts 顶部注释
 */
export const db = {
  /** 示例表 DAO(配合 pages/Example 演示) */
  example: {
    /** 查询全部记录(按创建时间倒序) */
    list(): Promise<ExampleRecord[]> {
      return window.api.db.example.list()
    },
    /** 新增记录 */
    add(content: string): Promise<ExampleRecord> {
      return window.api.db.example.add(content)
    },
    /** 删除记录 */
    remove(id: number): Promise<void> {
      return window.api.db.example.remove(id)
    },
    /** 清空表 */
    clear(): Promise<void> {
      return window.api.db.example.clear()
    }
  }
}
