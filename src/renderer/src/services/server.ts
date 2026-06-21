import { request } from '@/request'
import { ServerApiUrls } from '@/request/urls'

export interface ServerUser {
  id: string
  username: string
  role: 'member' | 'admin'
  groupId: string | null
  /** 是否已禁用(管理列表返回,登录响应可能缺省) */
  disabled?: boolean
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

// ===== 管理 API(仅管理员可调用,服务端 requireAdmin 守卫) =====

/** 用户组 */
export interface ServerGroup {
  id: string
  name: string
  createdAt: number
}

/** 列出全部用户 */
export function adminListUsers(): Promise<ServerUser[]> {
  return request.get<ServerUser[]>(ServerApiUrls.adminUsers)
}

/** 新建用户(可指定角色与所属组) */
export function adminCreateUser(input: {
  username: string
  password: string
  role: 'member' | 'admin'
  groupId: string | null
}): Promise<ServerUser> {
  return request.post<ServerUser>(ServerApiUrls.adminUsers, input)
}

/** 更新用户:改组或启用/禁用 */
export function adminUpdateUser(
  id: string,
  patch: { groupId?: string; disabled?: boolean }
): Promise<{ updated: boolean }> {
  return request.patch<{ updated: boolean }>(`${ServerApiUrls.adminUsers}/${id}`, patch)
}

/** 列出全部用户组 */
export function adminListGroups(): Promise<ServerGroup[]> {
  return request.get<ServerGroup[]>(ServerApiUrls.adminGroups)
}

/** 新建用户组 */
export function adminCreateGroup(name: string): Promise<ServerGroup> {
  return request.post<ServerGroup>(ServerApiUrls.adminGroups, { name })
}
