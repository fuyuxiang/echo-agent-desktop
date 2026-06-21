import { ApiUrls } from '@/request/urls'
import { registerMock } from './registry'
import type { ExampleGreeting, ExampleItem } from '@/services/example'

/**
 * 示例模块 Mock 数据(与 services/example.ts 一一对应)
 */

registerMock('GET', ApiUrls.example.greeting, (): ExampleGreeting => {
  return {
    message: '你好,这是来自 Mock 的问候 👋',
    timestamp: Date.now()
  }
})

registerMock('GET', ApiUrls.example.list, (params): ExampleItem[] => {
  const keyword = String(params.keyword ?? '')
  const all: ExampleItem[] = [
    { id: '1', title: 'Electron 主进程基建', done: true },
    { id: '2', title: '类型安全的 IPC 桥接', done: true },
    { id: '3', title: '本地数据库 better-sqlite3', done: true },
    { id: '4', title: '按 Figma 开发业务页面', done: false }
  ]
  return keyword ? all.filter((item) => item.title.includes(keyword)) : all
})
