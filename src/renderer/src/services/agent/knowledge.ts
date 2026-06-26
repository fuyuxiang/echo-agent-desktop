// src/renderer/src/services/agent/knowledge.ts
// P6: 知识库后端未上线,显式提示避免静默失败
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

function notImpl(method: string): Promise<never> {
  return Promise.reject(new Error(`knowledge.${method} 暂未提供(知识库后端规划中)`))
}

export const knowledgeAPI = {
  getStatus: (): Promise<KnowledgeStatus> => notImpl('getStatus'),
  rebuild: (): Promise<{ success?: boolean }> => notImpl('rebuild'),
  upload: (_file: File): Promise<unknown> => notImpl('upload'),
  listDocuments: (): Promise<KnowledgeDocumentsResponse> => notImpl('listDocuments'),
  deleteDocument: (_path: string): Promise<{ success?: boolean }> => notImpl('deleteDocument')
}
