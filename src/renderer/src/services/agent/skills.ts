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

export interface SkillDeps {
  name: string
  requires: string[]
  missing: string[]
  satisfied: boolean
}

export interface InstallResult {
  success: boolean
  installed: string[]
  skipped: string[]
  rejected: string[]
  detail: string
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
      .then((r) => r.data),

  remove: (name: string) =>
    agentRequest
      .delete<{ success?: boolean }>(`${getBaseUrl()}${AgentApiUrls.skillDelete(name)}`)
      .then((r) => r.data),

  getDeps: (name: string) =>
    agentRequest
      .get<SkillDeps>(`${getBaseUrl()}${AgentApiUrls.skillDeps(name)}`)
      .then((r) => r.data),

  installDeps: (name: string) =>
    agentRequest
      .post<InstallResult>(`${getBaseUrl()}${AgentApiUrls.skillInstallDeps(name)}`)
      .then((r) => r.data)
}
