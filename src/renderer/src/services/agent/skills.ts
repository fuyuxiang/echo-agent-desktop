import { agentRequest } from './proxy-request'
import { AgentApiUrls } from '@/request/urls'
import { useAgentStore } from '@/stores/agentStore'

function getBaseUrl(): string {
  return useAgentStore.getState().baseUrl
}

export interface Skill {
  name: string
  description: string
  category: string
  version: string
  tags: string[]
  enabled: boolean
}

export interface SkillDetail {
  content: string
  files: string[]
}

export const skillsAPI = {
  list: () =>
    agentRequest
      .get<{ skills: Skill[] }>(`${getBaseUrl()}${AgentApiUrls.skills}`)
      .then((r) => r.data),

  get: (name: string) =>
    agentRequest
      .get<SkillDetail>(`${getBaseUrl()}${AgentApiUrls.skillDetail(name)}`)
      .then((r) => r.data),

  toggle: (name: string) =>
    agentRequest
      .post<{ success?: boolean }>(`${getBaseUrl()}${AgentApiUrls.skillToggle(name)}`)
      .then((r) => r.data),

  importFromPath: (path: string) =>
    agentRequest
      .post<{ success?: boolean; skill?: Skill }>(`${getBaseUrl()}${AgentApiUrls.skillImport}`, {
        path
      })
      .then((r) => r.data)
}
