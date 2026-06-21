/**
 * Mock 注册表(独立文件,避免与各 mock 模块产生循环依赖)
 * 各 mock/xxx.ts 从此处 import registerMock
 */

/** Mock handler:入参为请求参数(GET 为 query,POST 为 body),返回业务数据 */
export type MockHandler = (params: Record<string, unknown>) => unknown

const registry = new Map<string, MockHandler>()

/** 生成注册键 */
function keyOf(method: string, url: string): string {
  return `${method.toUpperCase()} ${url}`
}

/**
 * 注册一个 Mock 接口
 * @param method 请求方法(GET/POST/PUT/DELETE)
 * @param url 接口路径(必须与 request/urls.ts 中常量一致)
 * @param handler 返回业务数据(无需包 BaseData,adapter 自动包装)
 */
export function registerMock(method: string, url: string, handler: MockHandler): void {
  registry.set(keyOf(method, url), handler)
}

/** 查找 Mock handler(request 的 mock adapter 内部使用) */
export function resolveMock(method: string, url: string): MockHandler | undefined {
  return registry.get(keyOf(method, url))
}
