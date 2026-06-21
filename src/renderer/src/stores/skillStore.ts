import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import type { Skill } from '@/services/agent/skills'

interface SkillState {
  skills: Skill[]
  /** 技能库页面正在浏览详情的技能(仅用于详情面板,与聊天无关) */
  selectedSkill: string | null
  /** 聊天输入框激活的技能(发送时拼入任务,持续生效直到手动取消) */
  activeSkill: string | null
  setSkills: (skills: Skill[]) => void
  setSelectedSkill: (name: string | null) => void
  setActiveSkill: (name: string | null) => void
}

export const useSkillStore = create<SkillState>()(
  immer((set) => ({
    skills: [],
    selectedSkill: null,
    activeSkill: null,
    setSkills: (skills) =>
      set((s) => {
        s.skills = skills
      }),
    setSelectedSkill: (name) =>
      set((s) => {
        s.selectedSkill = name
      }),
    setActiveSkill: (name) =>
      set((s) => {
        s.activeSkill = name
      })
  }))
)
