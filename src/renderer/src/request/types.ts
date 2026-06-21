/**
 * 网络层通用类型
 */

/** 业务成功状态码(后台约定变更时只改这里) */
export const SUCCESS_CODE = 0

/** 后台统一响应结构 */
export interface BaseData<T = unknown> {
  /** 业务状态码,SUCCESS_CODE 为成功,其余为业务错误 */
  code: number
  /** 提示信息,业务错误时用于 toast 展示 */
  msg: string
  /** 业务数据 */
  data: T
}

/** 业务错误(code 非成功时由拦截器抛出,页面可 catch 后做精细处理) */
export class BizError extends Error {
  /** 后台返回的业务状态码 */
  code: number

  constructor(code: number, msg: string) {
    super(msg)
    this.name = 'BizError'
    this.code = code
  }
}
