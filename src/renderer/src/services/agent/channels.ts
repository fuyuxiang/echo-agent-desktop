import { agentRequest } from './proxy-request'
import { AgentApiUrls } from '@/request/urls'
import { useAgentStore } from '@/stores/agentStore'

function getBaseUrl(): string {
  return useAgentStore.getState().baseUrl
}

export interface Channel {
  name: string
  enabled: boolean
  running: boolean
}

export const channelsAPI = {
  list: () =>
    agentRequest
      .get<{ channels: Channel[] }>(`${getBaseUrl()}${AgentApiUrls.channels}`)
      .then((r) => r.data)
}
