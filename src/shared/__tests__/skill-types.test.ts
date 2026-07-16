import { describe, it, expect } from 'vitest'
import type {
  SkillConfig,
  SkillCategory,
  SkillListResponse,
  SkillInstallRequest,
  SkillUninstallRequest,
  SkillUpdateRequest
} from '../skill-types'

describe('Skill Types', () => {
  it('should define SkillConfig interface', () => {
    const skill: SkillConfig = {
      id: 'skill-1',
      name: 'Web Search',
      description: 'Search the web for information',
      version: '1.0.0',
      author: 'Echo',
      category: 'utility',
      isInstalled: true,
      isActive: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    expect(skill).toBeDefined()
    expect(skill.name).toBe('Web Search')
  })

  it('should support optional fields in SkillConfig', () => {
    const skill: SkillConfig = {
      id: 'skill-2',
      name: 'Code Assistant',
      description: 'Help with coding tasks',
      version: '2.1.0',
      author: 'Echo Team',
      category: 'development',
      isInstalled: false,
      isActive: false,
      metadata: { tags: ['coding', 'ai'], rating: 4.5 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    expect(skill.metadata?.tags).toEqual(['coding', 'ai'])
    expect(skill.metadata?.rating).toBe(4.5)
  })

  it('should define SkillCategory interface', () => {
    const category: SkillCategory = {
      id: 'cat-1',
      name: 'Utility',
      description: 'Utility skills',
      skillCount: 10
    }
    expect(category).toBeDefined()
    expect(category.name).toBe('Utility')
  })

  it('should define SkillListResponse interface', () => {
    const response: SkillListResponse = {
      skills: [],
      categories: [],
      total: 0
    }
    expect(response).toBeDefined()
    expect(response.total).toBe(0)
  })

  it('should support populated SkillListResponse', () => {
    const response: SkillListResponse = {
      skills: [
        {
          id: 'skill-1',
          name: 'Web Search',
          description: 'Search the web',
          version: '1.0.0',
          author: 'Echo',
          category: 'utility',
          isInstalled: true,
          isActive: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ],
      categories: [
        {
          id: 'cat-1',
          name: 'Utility',
          description: 'Utility skills',
          skillCount: 1
        }
      ],
      total: 1
    }
    expect(response.skills).toHaveLength(1)
    expect(response.categories).toHaveLength(1)
    expect(response.total).toBe(1)
  })

  it('should define SkillInstallRequest interface', () => {
    const request: SkillInstallRequest = {
      skillId: 'skill-1'
    }
    expect(request).toBeDefined()
    expect(request.skillId).toBe('skill-1')
    expect(request.version).toBeUndefined()
  })

  it('should support optional version in SkillInstallRequest', () => {
    const request: SkillInstallRequest = {
      skillId: 'skill-1',
      version: '2.0.0'
    }
    expect(request.version).toBe('2.0.0')
  })

  it('should define SkillUninstallRequest interface', () => {
    const request: SkillUninstallRequest = {
      skillId: 'skill-1'
    }
    expect(request).toBeDefined()
    expect(request.skillId).toBe('skill-1')
  })

  it('should define SkillUpdateRequest interface', () => {
    const request: SkillUpdateRequest = {
      id: 'skill-1'
    }
    expect(request).toBeDefined()
    expect(request.id).toBe('skill-1')
    expect(request.isActive).toBeUndefined()
    expect(request.metadata).toBeUndefined()
  })

  it('should support optional fields in SkillUpdateRequest', () => {
    const request: SkillUpdateRequest = {
      id: 'skill-1',
      isActive: false,
      metadata: { customSetting: true }
    }
    expect(request.isActive).toBe(false)
    expect(request.metadata?.customSetting).toBe(true)
  })
})
