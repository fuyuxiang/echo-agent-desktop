import axios, { type AxiosRequestConfig, type AxiosResponse } from 'axios'
import { toast } from '@/components/Toast'
import { logger } from '@/utils/logger'
import { storage } from '@/utils/storage'
import { resolveMock } from '@/mock'
import { API_HOST } from './urls'
import { BizError, SUCCESS_CODE, type BaseData } from './types'

/**
 * 网络请求层(axios 封装)
 *
 * - 统一响应结构 BaseData<T>,拦截器自动解包: 业务代码直接拿到 data(T)
 * - code 非 0: 抛 BizError 并全局 toast 提示,页面无需重复处理
 * - VITE_USE_MOCK=true 时走 mock adapter,返回 mock/ 目录注册的数据
 *
 * 使用方式(services/ 中):
 *   const data = await request.get<ExampleItem[]>(ApiUrls.example.list, { params })
 */

const USE_MOCK = import.meta.env.VITE_USE_MOCK === 'true'

/**
 * 主进程代理 adapter:渲染进程经 IPC 走主进程发请求,绕过浏览器 CORS 限制。
 * 服务端(echo-agent-server)未开放跨域,且打包后渲染层是 file://,故所有
 * 业务请求统一走主进程 net.fetch。仅在 Electron(window.api 存在)时启用。
 */
async function ipcProxyAdapter(config: AxiosRequestConfig): Promise<AxiosResponse> {
  const base = (config.baseURL ?? '').replace(/\/+$/, '')
  const rawUrl = config.url ?? ''
  let url = /^https?:\/\//.test(rawUrl) ? rawUrl : `${base}${rawUrl}`

  // 拼接 query 参数
  if (config.params && typeof config.params === 'object') {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(config.params as Record<string, unknown>)) {
      if (v !== undefined && v !== null) qs.append(k, String(v))
    }
    const q = qs.toString()
    if (q) url += (url.includes('?') ? '&' : '?') + q
  }

  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries((config.headers ?? {}) as Record<string, unknown>)) {
    if (v !== undefined && v !== null && typeof v !== 'object') headers[k] = String(v)
  }

  const body =
    config.data === undefined || config.data === null
      ? undefined
      : typeof config.data === 'string'
        ? config.data
        : JSON.stringify(config.data)
  if (body && !headers['Content-Type'] && !headers['content-type']) {
    headers['Content-Type'] = 'application/json'
  }

  const result = await window.api.agent.httpProxy({
    url,
    method: (config.method ?? 'get').toUpperCase(),
    headers,
    body
  })

  let data: unknown
  try {
    data = JSON.parse(result.body)
  } catch {
    data = result.body
  }

  return {
    data,
    status: result.status,
    statusText: result.ok ? 'OK' : 'Error',
    headers: {},
    config
  } as AxiosResponse
}

/** Mock adapter:拦截请求,从注册表返回数据(模拟 300ms 网络延迟) */
async function mockAdapter(config: AxiosRequestConfig): Promise<AxiosResponse> {
  const method = (config.method ?? 'get').toUpperCase()
  const url = config.url ?? ''
  const handler = resolveMock(method, url)

  await new Promise((r) => setTimeout(r, 300))

  if (!handler) {
    logger.warn(`[mock] 未注册的接口: ${method} ${url},请在 src/renderer/src/mock/ 中补充`)
    const body: BaseData = { code: 404, msg: `Mock 未注册: ${method} ${url}`, data: null }
    return { data: body, status: 200, statusText: 'OK', headers: {}, config } as AxiosResponse
  }

  const params = {
    ...(config.params as Record<string, unknown>),
    ...(typeof config.data === 'string' ? JSON.parse(config.data) : config.data)
  }
  const body: BaseData = { code: SUCCESS_CODE, msg: 'ok', data: handler(params ?? {}) }
  return { data: body, status: 200, statusText: 'OK', headers: {}, config } as AxiosResponse
}

const hasIpcProxy =
  typeof window !== 'undefined' && typeof window.api?.agent?.httpProxy === 'function'

const instance = axios.create({
  baseURL: API_HOST,
  timeout: 15000,
  ...(USE_MOCK ? { adapter: mockAdapter } : hasIpcProxy ? { adapter: ipcProxyAdapter } : {})
})

// ===== 请求拦截器:自动携带 token =====
instance.interceptors.request.use(async (config) => {
  const token = await storage.secure.get('token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

// ===== 响应拦截器:统一解包 BaseData + 统一错误处理 =====
instance.interceptors.response.use(
  (response) => {
    const body = response.data as BaseData
    // 非标准结构(如文件流)原样返回
    if (body === null || typeof body !== 'object' || !('code' in body)) {
      return response.data
    }
    if (body.code !== SUCCESS_CODE) {
      toast.error(body.msg || '请求失败')
      logger.warn(`[request] 业务错误 code=${body.code} msg=${body.msg} url=${response.config.url}`)
      throw new BizError(body.code, body.msg)
    }
    // 解包:业务代码直接拿到 data
    return body.data as never
  },
  (error) => {
    // 网络层错误(超时/断网/5xx)
    const msg = error?.message?.includes('timeout') ? '请求超时,请稍后重试' : '网络异常,请检查网络'
    toast.error(msg)
    logger.error(`[request] 网络错误: ${error?.message} url=${error?.config?.url}`)
    return Promise.reject(error)
  }
)

/**
 * 类型化请求门面
 * 注意: 拦截器已解包,泛型 T 即业务数据类型(不是 BaseData<T>)
 */
export const request = {
  get<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
    return instance.get(url, config)
  },
  post<T>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
    return instance.post(url, data, config)
  },
  put<T>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
    return instance.put(url, data, config)
  },
  delete<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
    return instance.delete(url, config)
  },
  patch<T>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
    return instance.patch(url, data, config)
  }
}

export { BizError, SUCCESS_CODE } from './types'
export type { BaseData } from './types'

/** 不经过 BaseData 解包的原始 axios 实例（用于直接调用 echo-agent API） */
export const rawRequest = axios.create({
  timeout: 30000
})
