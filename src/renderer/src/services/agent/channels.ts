// src/renderer/src/services/agent/channels.ts
// P6: 频道(知识库 RAG channels)后端未上线,显式提示避免静默失败
export interface Channel {
  id: string
  name: string
  enabled: boolean
  running: boolean
}

function notImpl(method: string): Promise<never> {
  return Promise.reject(new Error(`channels.${method} 暂未提供(频道后端规划中)`))
}

export const channelsAPI = {
  list: (): Promise<{ channels: Channel[] }> => notImpl('list')
}
