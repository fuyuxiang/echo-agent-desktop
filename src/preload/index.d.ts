import type { BridgeApi } from '../shared/types/api'

/**
 * 渲染层全局类型声明:window.api
 * 业务代码请通过 utils/ 门面调用,不要直接使用 window.api
 */
declare global {
  interface Window {
    api: BridgeApi
  }
}

export {}
