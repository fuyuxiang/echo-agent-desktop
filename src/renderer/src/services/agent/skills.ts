// src/renderer/src/services/agent/skills.ts
// Skills 走 echo-agent 网关: Desktop 仅做镜像展示 + 激活态转发。
// 真实数据(列表/状态/依赖/版本)由 echo-agent 通过 skill.list 帧返回;
// 启用/禁用通过 skill.enable / skill.disable 帧发给 echo-agent。
// 原 window.api.agentSkill.* 已在 Task 6 删除,IPC 桥接走 agentChat.sendSkill* 异步配对。

import { agentWs } from './runtime-client'

export interface Skill {
  id: string
  label: string
  description: string
  kind: 'prompt' | 'code'
  /** echo-agent 上报的状态 */
  status: 'installed' | 'enabled' | 'disabled' | 'error'
  version?: string
  dependencies?: string[]
}

export interface SkillDetail {
  content: string
  files: string[]
}

function fromEchoAgent(raw: Record<string, unknown>): Skill {
  return {
    id: String(raw.name ?? ''),
    label: String(raw.name ?? ''),
    description: String(raw.description ?? ''),
    // echo-agent 不区分 prompt/code,统一标记为 code
    kind: 'code',
    status: (raw.status as Skill['status']) ?? 'installed',
    version: raw.version as string | undefined,
    dependencies: (raw.dependencies as string[] | undefined) ?? undefined
  }
}

export const skillsAPI = {
  list: (): Promise<{ skills: Skill[] }> =>
    agentWs.sendSkillList().then((rows) => ({ skills: rows.map(fromEchoAgent) })),

  get: (_id: string): Promise<SkillDetail> => {
    // 详情暂未对接 echo-agent,返回空骨架
    return Promise.resolve({ content: '', files: [] })
  },

  /** 激活态改为全局,chatId 参数保留以兼容旧签名但忽略。 */
  activate: (_chatId: string, skillId: string): Promise<{ success: boolean }> =>
    agentWs.sendSkillEnable(skillId).then(() => ({ success: true })),

  deactivate: (_chatId: string, skillId: string): Promise<{ success: boolean }> =>
    agentWs.sendSkillDisable(skillId).then(() => ({ success: true })),

  /** 旧方法已下线,保留以避免编译错误,但永远返回失败提示。 */
  importFromPath: (_path: string): Promise<{ success: boolean; error?: string }> =>
    Promise.resolve({ success: false, error: 'imported skills 已下线,请编辑 ~/.echo-agent/skills/' }),

  remove: (_name: string): Promise<{ success: boolean; error?: string }> =>
    Promise.resolve({ success: false, error: '删除 skill 请在 echo-agent 端操作' })
}