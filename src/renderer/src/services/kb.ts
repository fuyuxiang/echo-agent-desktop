/**
 * kb 知识库子系统 - 客户端服务契约
 * 类型与运行时函数同居(kb.ts),与 echo-agent-server/src/kb/types.ts 字段一一对应
 * - 列表/详情/状态: 对应服务端 /api/kb/documents[/:id[/:id/status]]
 * - 上传: multipart/form-data,支持 onUploadProgress
 * - 问答/反馈: 对应服务端 /api/kb/ask 与 /api/kb/qa/:qaLogId/feedback
 */

import { request } from '@/request'

// ===== 类型(与 kb/types.ts 对齐) =====

export type KbDocumentType = 'text' | 'docx' | 'pdf' | 'excel' | 'audio' | 'video'

export type KbDocumentStatus =
  | 'pending'
  | 'parsing'
  | 'indexing'
  | 'ready'
  | 'failed'

export interface KbDocument {
  id: string
  name: string
  type: KbDocumentType
  status: KbDocumentStatus
  hash: string
  version: number
  errorMessage: string | null
  createdAt: number
  updatedAt: number
}

export interface KbLocationPageSection {
  kind: 'page_section'
  page: number
  section?: string
}
export interface KbLocationSheetCell {
  kind: 'sheet_cell'
  sheet: string
  cellRange: string
}
export interface KbLocationTimestamp {
  kind: 'timestamp'
  startMs: number
  endMs: number
}
export interface KbLocationPlain {
  kind: 'plain'
  offset: number
  length: number
}
export type KbLocation =
  | KbLocationPageSection
  | KbLocationSheetCell
  | KbLocationTimestamp
  | KbLocationPlain

export interface KbCitation {
  unitId: string
  docId: string
  docName: string
  location: KbLocation
  excerpt: string
}

export type KbConfidence = 'high' | 'medium' | 'low'

export interface KbAskRequest {
  query: string
  topK?: number
}

export interface KbAskResult {
  answer: string
  citations: KbCitation[]
  confidence: KbConfidence
  fallbackMaterialList?: { docId: string; docName: string }[]
}

export interface KbAskFeedback {
  qaLogId: string
  feedback: 1 | -1
}

export interface KbListDocumentsResponse {
  items: KbDocument[]
  total: number
}

// ===== 运行时函数 =====

/** 列出资料库文档(分页) */
export async function listKbDocuments(
  params: { limit?: number; offset?: number } = {}
): Promise<KbListDocumentsResponse> {
  return request.get<KbListDocumentsResponse>('/api/kb/documents', { params })
}

/** 获取单个资料库文档详情(含摘要) */
export async function getKbDocument(
  id: string
): Promise<KbDocument & { summary: string }> {
  return request.get<KbDocument & { summary: string }>(`/api/kb/documents/${id}`)
}

/** 查询资料库文档处理状态 */
export async function getKbDocumentStatus(
  id: string
): Promise<{ status: KbDocument['status']; errorMessage: string | null }> {
  return request.get<{ status: KbDocument['status']; errorMessage: string | null }>(
    `/api/kb/documents/${id}/status`
  )
}

/**
 * 上传资料库文档(multipart/form-data)
 * onProgress 为可选的上传进度回调(0-100)
 */
export async function uploadKbDocument(
  file: File,
  onProgress?: (pct: number) => void
): Promise<KbDocument> {
  const fd = new FormData()
  fd.append('file', file)
  return request.post<KbDocument>('/api/kb/upload', fd, {
    headers: { 'content-type': 'multipart/form-data' },
    onUploadProgress: (e) =>
      onProgress?.(Math.round((e.loaded * 100) / (e.total || 1)))
  })
}

/** 资料库问答 */
export async function askKb(req: KbAskRequest): Promise<KbAskResult> {
  return request.post<KbAskResult>('/api/kb/ask', req)
}

/** 提交问答反馈(点赞/点踩) */
export async function submitKbFeedback(
  fb: KbAskFeedback
): Promise<{ ok: true }> {
  return request.post<{ ok: true }>(`/api/kb/qa/${fb.qaLogId}/feedback`, {
    feedback: fb.feedback
  })
}
