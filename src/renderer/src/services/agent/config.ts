// src/renderer/src/services/agent/config.ts
// P6: 模型/配置管理改由 model-bootstrap + agent:chat:init 装配,本文件保留空 stub
function notImpl(method: string): Promise<never> {
  return Promise.reject(new Error(`config.${method} 暂未提供(用 model-bootstrap 装配)`))
}

export const configAPI = {
  get: (): Promise<unknown> => notImpl('get'),
  getModels: (): Promise<unknown> => notImpl('getModels')
}
