import { request } from '@/request'
import { ApiUrls } from '@/request/urls'

/**
 * 示例模块接口(与 pages/Example 配套,新模块依葫芦画瓢)
 *
 * 三步定义一个接口:
 * 1. request/urls.ts 中添加路径常量
 * 2. 此处定义「请求参数 + 响应数据」TS 类型与请求函数
 * 3. mock/ 中注册同路径的 Mock 数据(后台就绪后无需改动此文件)
 */

/** 问候语响应 */
export interface ExampleGreeting {
  /** 问候内容 */
  message: string
  /** 服务端时间戳 */
  timestamp: number
}

/** 列表项 */
export interface ExampleItem {
  /** 唯一 ID */
  id: string
  /** 标题 */
  title: string
  /** 是否完成 */
  done: boolean
}

/** 列表查询参数 */
export interface ExampleListParams {
  /** 标题关键字(可选) */
  keyword?: string
}

/** 获取问候语 */
export function fetchGreeting(): Promise<ExampleGreeting> {
  return request.get<ExampleGreeting>(ApiUrls.example.greeting)
}

/** 获取示例列表 */
export function fetchExampleList(params?: ExampleListParams): Promise<ExampleItem[]> {
  return request.get<ExampleItem[]>(ApiUrls.example.list, { params })
}
