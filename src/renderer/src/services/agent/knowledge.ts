// src/renderer/src/services/agent/knowledge.ts
import { agentManagement } from './management'
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
  getStatus: (): Promise<KnowledgeStatus> =>
    agentManagement({ method: 'GET', path: '/knowledge/status' }),
  rebuild: (): Promise<{ success?: boolean }> =>
    agentManagement({ method: 'POST', path: '/knowledge/rebuild' }),
  upload: async (file: File): Promise<unknown> =>
    agentManagement({
      method: 'POST',
      path: '/knowledge/upload',
      file: {
        name: file.name,
        mimeType: file.type || 'application/octet-stream',
        data: new Uint8Array(await file.arrayBuffer())
      }
    }),
  listDocuments: (): Promise<KnowledgeDocumentsResponse> =>
    agentManagement({ method: 'GET', path: '/knowledge/documents' }),
  deleteDocument: (docPath: string): Promise<{ success?: boolean }> =>
    agentManagement({
      method: 'DELETE',
      path: `/knowledge/documents/${docPath.split('/').map(encodeURIComponent).join('/')}`
    })
}
