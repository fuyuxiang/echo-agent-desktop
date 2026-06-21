import { agentHttp } from '@/utils/agent'
import { AgentApiUrls } from '@/request/urls'

/** 个人记忆(本地 echo-agent 维护,存于用户本机) */
export interface PersonalMemory {
  id: string
  type: string
  tier: string
  key: string
  content: string
  tags: string[]
  importance: number
}

/** 列出全部个人记忆 */
export function listPersonalMemory(): Promise<PersonalMemory[]> {
  return agentHttp<PersonalMemory[]>(AgentApiUrls.memory)
}

/** 语义检索个人记忆 */
export function searchPersonalMemory(query: string): Promise<PersonalMemory[]> {
  return agentHttp<PersonalMemory[]>(AgentApiUrls.memorySearch, {
    method: 'POST',
    body: { query }
  })
}

/** 删除一条个人记忆 */
export function deletePersonalMemory(id: string): Promise<void> {
  return agentHttp<void>(AgentApiUrls.memoryDetail(id), { method: 'DELETE' })
}
