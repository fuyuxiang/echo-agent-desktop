// src/renderer/src/services/agent/skills.ts
// Skills 走 echo-agent 网关: Desktop 仅做镜像展示 + 激活态转发。
// 真实数据(列表/状态/分类/版本/标签)由 echo-agent 通过 skill.list 帧返回;
// 启用/禁用通过 skill.enable / skill.disable 帧发给 echo-agent。
// 原 window.api.agentSkill.* 已在 Task 6 删除,IPC 桥接走 agentChat.sendSkill* 异步配对。
//
// echo-agent SkillMeta.to_dict() 字段(2026-08 修订):
//   name / description / category / version / tags
//   + ws_skill.handle_skill_list 追加 enabled(bool)
//
// 旧 spec 假设的字段(status / dependencies)已被专家修订,不再存在。

import { agentManagement } from './management'

export interface Skill {
  id: string
  label: string
  description: string
  kind: 'prompt' | 'code'
  /** echo-agent 上报的启用状态(enabled 字段) */
  status: 'installed' | 'enabled' | 'disabled' | 'error'
  category?: string
  tags?: string[]
  version?: string
}

export interface SkillDetail {
  content: string
  files: string[]
}

function fromEchoAgent(raw: Record<string, unknown>): Skill {
  // echo-agent 用 enabled bool 表示是否启用,UI 端映射成 status 字符串
  const enabled = raw.enabled === true
  return {
    id: String(raw.name ?? ''),
    label: String(raw.name ?? ''),
    description: String(raw.description ?? ''),
    // echo-agent 不区分 prompt/code,统一标记为 code
    kind: 'code',
    status: enabled ? 'enabled' : 'disabled',
    category: typeof raw.category === 'string' ? raw.category : undefined,
    tags: Array.isArray(raw.tags) ? (raw.tags as string[]) : undefined,
    version: typeof raw.version === 'string' ? raw.version : undefined
  }
}

export const skillsAPI = {
  list: (): Promise<{ skills: Skill[] }> =>
    agentManagement<{ skills: Record<string, unknown>[] }>({ method: 'GET', path: '/skills' })
      .then((r) => ({ skills: r.skills.map(fromEchoAgent) })),

  get: (id: string): Promise<SkillDetail> =>
    agentManagement<SkillDetail>({ method: 'GET', path: `/skills/${encodeURIComponent(id)}` }),

  /** 激活态改为全局,chatId 参数保留以兼容旧签名但忽略。 */
  activate: (_chatId: string, skillId: string): Promise<{ success: boolean }> =>
    agentManagement({ method: 'POST', path: `/skills/${encodeURIComponent(skillId)}/toggle` }),

  deactivate: (_chatId: string, skillId: string): Promise<{ success: boolean }> =>
    agentManagement({ method: 'POST', path: `/skills/${encodeURIComponent(skillId)}/toggle` }),

  /** 旧方法已下线,保留以避免编译错误,但永远返回失败提示。 */
  importFromPath: (path: string): Promise<{ success: boolean; error?: string }> =>
    agentManagement({ method: 'POST', path: '/skills/import', body: { path } }),

  remove: (name: string): Promise<{ success: boolean; error?: string }> =>
    agentManagement({ method: 'DELETE', path: `/skills/${encodeURIComponent(name)}` })
}
