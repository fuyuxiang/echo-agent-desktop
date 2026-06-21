import { request } from '@/request'
import { ServerApiUrls } from '@/request/urls'

export interface ServerUser {
  id: string
  username: string
  role: 'member' | 'admin'
  groupId: string | null
}

export interface ModelConfigDTO {
  baseUrl: string | null
  modelName: string | null
  allowLocalOverride: boolean
  hasCredential: boolean
}

export function login(
  username: string,
  password: string
): Promise<{ token: string; user: ServerUser }> {
  return request.post<{ token: string; user: ServerUser }>(ServerApiUrls.login, {
    username,
    password
  })
}

export function fetchModelConfig(): Promise<ModelConfigDTO> {
  return request.get<ModelConfigDTO>(ServerApiUrls.modelConfig)
}

/** 项目记忆(group_id 由服务端从 JWT 推导,客户端不传) */
export interface ProjectMemory {
  id: string
  groupId: string
  content: string
  tags: string[]
  sourceUser: string
  createdAt: number
  updatedAt: number
}

/** 语义检索项目记忆 */
export function searchProjectMemory(query: string, topK = 5): Promise<ProjectMemory[]> {
  return request.post<ProjectMemory[]>(ServerApiUrls.projectMemorySearch, { query, topK })
}

/** 写入一条项目记忆 */
export function writeProjectMemory(content: string, tags: string[] = []): Promise<ProjectMemory> {
  return request.post<ProjectMemory>(ServerApiUrls.projectMemory, { content, tags })
}

/** 分页列出项目记忆 */
export function listProjectMemory(limit = 50, offset = 0): Promise<ProjectMemory[]> {
  return request.get<ProjectMemory[]>(ServerApiUrls.projectMemory, { params: { limit, offset } })
}

/** 删除一条项目记忆 */
export function deleteProjectMemory(id: string): Promise<{ deleted: boolean }> {
  return request.delete<{ deleted: boolean }>(`${ServerApiUrls.projectMemory}/${id}`)
}
