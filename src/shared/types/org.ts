/**
 * 企业组织知识库(echo-agent-server)相关类型。
 *
 * 三层可见性:personal(本地,不上传) / team(分组) / org(全公司)。
 * 权限一律由服务端按 JWT 判定,这里的类型只描述数据形状。
 */

export type OrgRole = 'admin' | 'curator' | 'member'
export type ScopeKind = 'org' | 'team'

export interface OrgScope {
  id: string
  kind: ScopeKind
  name: string
  groupId: string | null
}

export interface OrgUser {
  id: string
  username: string
  displayName: string
  role: OrgRole
  clearance: number
  groups: { id: string; name: string }[]
  scopes: string[]
}

export interface OrgLoginResult {
  ok: boolean
  user?: OrgUser
  error?: string
}

export interface OrgStatus {
  /** 是否配置了服务器地址 */
  configured: boolean
  serverUrl: string
  /** 是否有可用凭证 */
  loggedIn: boolean
  user: OrgUser | null
  /** 服务器最近一次是否可达。null = 尚未探测 */
  reachable: boolean | null
  lastSyncAt: number | null
  cachedDocs: number
  cachedChunks: number
}

export interface Citation {
  page: number | null
  heading: string
  startMs: number | null
  endMs: number | null
  /** echo://doc/<id>/page/<n> 形式,供渲染层跳转 */
  openUrl: string
}

export interface RetrievedChunk {
  chunkId: string
  docId: string
  docTitle: string
  text: string
  score: number
  scopeKind: ScopeKind
  modality: string
  sourceType: string
  citation: Citation
  owner: { id: string; displayName: string } | null
  /** volatile 且超过阈值未更新 —— 答案里要提示核实 */
  stale: boolean
  updatedAt: number
}

export interface OrgMemoryHit {
  id: string
  kind: string
  content: string
  scopeKind: ScopeKind
  confidence: number
}

export interface RetrieveDiagnostics {
  bm25Hits: number
  vecHits: number
  fusedCandidates: number
  rerankMs: number
  rerankSkipped: boolean
  totalMs: number
}

export interface RetrieveResult {
  chunks: RetrievedChunk[]
  memories: OrgMemoryHit[]
  suggestAsk?: { userId: string; displayName: string; reason: string }[]
  diagnostics: RetrieveDiagnostics
  /** 结果来自本地缓存(服务器不可达时) */
  fromCache?: boolean
}

export interface OrgDocument {
  id: string
  title: string
  sourceType: string
  status: string
  byteSize: number
  sensitivity: number
  volatility: string
  createdAt: number
  updatedAt: number
  scopeId: string
  scopeKind: ScopeKind
  scopeName: string
  ownerName: string | null
  chunkCount: number
}

export interface OrgDocListResult {
  items: OrgDocument[]
  total: number
  page: number
  size: number
}

export type MemoryKind = 'fact' | 'decision' | 'convention' | 'pitfall' | 'howto'
export type PromotionSource = 'meeting' | 'qa' | 'task' | 'manual'
export type PromotionState = 'pending' | 'approved' | 'rejected' | 'withdrawn'

export interface PromoteMemoryInput {
  kind: MemoryKind
  content: string
  rationale?: string
  evidence?: { type: string; id: string; loc?: string }[]
}

export interface PromoteRequest {
  payloadType: 'memory' | 'document'
  payload: PromoteMemoryInput | { title: string; text: string; sourceType?: string }
  source: PromotionSource
  targetScope: string
}

export interface PromoteResult {
  ok: boolean
  promotionId?: string
  /** 离线时先入本地队列,联网后自动补提 */
  queued?: boolean
  error?: string
}

export interface MyPromotion {
  id: string
  payloadType: 'memory' | 'document'
  payload: unknown
  source: PromotionSource
  state: PromotionState
  reviewNote: string | null
  createdAt: number
  reviewedAt: number | null
  scopeName: string
  scopeKind: ScopeKind
  reviewerName: string | null
  /** 仅本地队列中的记录有此标记 */
  local?: boolean
}

export interface SyncResult {
  ok: boolean
  docs: number
  memories: number
  revoked: number
  error?: string
}

/**
 * 会议中抽取出的候选知识。
 *
 * 带原文引用与时间戳,让审核人能核对是否曲解了发言,也让后来人能回溯
 * "这话是谁在什么时候说的"。
 */
export interface KnowledgeCandidate {
  id: string
  kind: MemoryKind
  content: string
  rationale: string
  /** 支撑该条的原文片段 */
  quote: string
  /** 在录音中的位置(毫秒),便于回听确认 */
  startMs: number | null
  speaker: string | null
}
