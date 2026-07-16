export interface SkillConfig {
  id: string
  name: string
  description: string
  version: string
  author: string
  category: string
  isInstalled: boolean
  isActive: boolean
  metadata?: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface SkillCategory {
  id: string
  name: string
  description: string
  skillCount: number
}

export interface SkillListResponse {
  skills: SkillConfig[]
  categories: SkillCategory[]
  total: number
}

export interface SkillInstallRequest {
  skillId: string
  version?: string
}

export interface SkillUninstallRequest {
  skillId: string
}

export interface SkillUpdateRequest {
  id: string
  isActive?: boolean
  metadata?: Record<string, unknown>
}
