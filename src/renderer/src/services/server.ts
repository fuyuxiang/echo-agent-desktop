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
