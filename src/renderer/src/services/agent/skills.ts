// src/renderer/src/services/agent/skills.ts
// P6 sweep: 改走 window.api.agentSkill IPC,Python HTTP 后端已下线
// 删除 importFromPath / getDeps / installDeps / remove (Python lazy_deps 时代方法)

export interface Skill {
  id: string
  label: string
  description: string
  kind: 'prompt' | 'code'
}

export interface SkillDetail {
  content: string
  files: string[]
}

export const skillsAPI = {
  list: (): Promise<{ skills: Skill[] }> =>
    window.api.agentSkill.list().then((skills) => ({ skills: skills as Skill[] })),

  get: (_id: string): Promise<SkillDetail> => {
    // 详细配置未提供 IPC,仅返回空骨架(后续 P 阶段按需扩展)
    return Promise.resolve({ content: '', files: [] })
  },

  /** 切换激活态(per chatId): P6 改为按 chatId 显式 activate/deactivate */
  activate: (chatId: string, skillId: string): Promise<{ success: boolean }> =>
    window.api.agentSkill.activate(chatId, skillId),

  deactivate: (chatId: string, skillId: string): Promise<{ success: boolean }> =>
    window.api.agentSkill.deactivate(chatId, skillId),

  /** P4 起旧 Python lazy_deps 字段已删除:importFromPath/getDeps/installDeps/remove 不再支持 */
  importFromPath: (_path: string): Promise<{ success: boolean; error?: string }> =>
    Promise.resolve({ success: false, error: '技能动态加载已下线,代码型技能编译进 bundle' }),

  remove: (_name: string): Promise<{ success: boolean; error?: string }> =>
    Promise.resolve({ success: false, error: '技能删除请编辑 src/main/agent/skills/builtin/' })
}
