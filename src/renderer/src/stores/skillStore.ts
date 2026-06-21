import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import type { Skill } from '@/services/agent/skills'

interface SkillState {
  skills: Skill[]
  selectedSkill: string | null
  setSkills: (skills: Skill[]) => void
  setSelectedSkill: (name: string | null) => void
}

export const useSkillStore = create<SkillState>()(
  immer((set) => ({
    skills: [],
    selectedSkill: null,
    setSkills: (skills) =>
      set((s) => {
        s.skills = skills
      }),
    setSelectedSkill: (name) =>
      set((s) => {
        s.selectedSkill = name
      })
  }))
)
