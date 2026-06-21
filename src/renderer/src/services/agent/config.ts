import { rawRequest } from '@/request'
import { AgentApiUrls } from '@/request/urls'
import { useAgentStore } from '@/stores/agentStore'

function getBaseUrl(): string {
  return useAgentStore.getState().baseUrl
}

export const configAPI = {
  get: () => rawRequest.get(`${getBaseUrl()}${AgentApiUrls.config}`).then((r) => r.data),

  getModels: () => rawRequest.get(`${getBaseUrl()}${AgentApiUrls.configModels}`).then((r) => r.data)
}
