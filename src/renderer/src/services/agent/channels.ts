// src/renderer/src/services/agent/channels.ts
import { agentManagement } from './management'

export interface Channel {
  id: string
  name: string
  enabled: boolean
  running: boolean
}

export const channelsAPI = {
  list: (): Promise<{ channels: Channel[] }> =>
    agentManagement({ method: 'GET', path: '/channels' })
}
