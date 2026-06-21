import { agentRequest } from './proxy-request'
import { AgentApiUrls } from '@/request/urls'
import { useAgentStore } from '@/stores/agentStore'

function getBaseUrl(): string {
  return useAgentStore.getState().baseUrl
}

export interface KnowledgeStatus {
  indexed: number
  total: number
}

export interface KnowledgeDocument {
  path: string
  size?: number
}

export interface KnowledgeDocumentsResponse {
  documents: KnowledgeDocument[]
}

export const knowledgeAPI = {
  getStatus: () =>
    agentRequest
      .get<KnowledgeStatus>(`${getBaseUrl()}${AgentApiUrls.knowledgeStatus}`)
      .then((r) => r.data),

  rebuild: () =>
    agentRequest
      .post<{ success?: boolean }>(`${getBaseUrl()}${AgentApiUrls.knowledgeRebuild}`)
      .then((r) => r.data),

  upload: async (file: File) => {
    // 文件上传需要特殊处理，暂时保留 fetch 方式（文件上传场景较少）
    const { remoteToken } = useAgentStore.getState()
    const form = new FormData()
    form.append('file', file)
    const resp = await fetch(`${getBaseUrl()}${AgentApiUrls.knowledgeUpload}`, {
      method: 'POST',
      headers: remoteToken ? { 'X-Echo-Agent-Token': remoteToken } : undefined,
      body: form
    })
    // 必须检查 HTTP 状态: 否则 4xx/5xx 会被 r.json() 当成功解析, 上传失败被静默吞掉
    if (!resp.ok) {
      throw new Error(`上传失败 HTTP ${resp.status}`)
    }
    return resp.json()
  },

  listDocuments: () =>
    agentRequest
      .get<KnowledgeDocumentsResponse>(`${getBaseUrl()}${AgentApiUrls.knowledgeDocuments}`)
      .then((r) => r.data),

  deleteDocument: (path: string) =>
    agentRequest
      .delete<{ success?: boolean }>(`${getBaseUrl()}${AgentApiUrls.knowledgeDocDelete(path)}`)
      .then((r) => r.data)
}
