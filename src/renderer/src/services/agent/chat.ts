import { agentRequest } from './proxy-request'
import { AgentApiUrls } from '@/request/urls'
import { useAgentStore } from '@/stores/agentStore'

function getBaseUrl(): string {
  return useAgentStore.getState().baseUrl
}

export interface Session {
  session_key: string
  platform: string
  chat_id: string
  last_activity: string
  message_count: number
}

export const chatAPI = {
  getSessions: () =>
    agentRequest
      .get<{ sessions: Session[] }>(`${getBaseUrl()}${AgentApiUrls.sessions}`)
      .then((r) => r.data),

  deleteSession: (key: string) =>
    agentRequest.delete(`${getBaseUrl()}${AgentApiUrls.sessionDelete(key)}`).then((r) => r.data),

  sendMessage: (text: string, opts?: { wait?: boolean }) =>
    agentRequest
      .post(`${getBaseUrl()}${AgentApiUrls.message}`, {
        platform: 'desktop',
        user_id: 'local-user',
        chat_id: useAgentStore.getState().currentSessionKey,
        text,
        wait: opts?.wait ?? false
      })
      .then((r) => r.data)
}
