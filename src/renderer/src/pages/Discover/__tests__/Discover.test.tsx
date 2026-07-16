// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkillConfig, SkillCategory } from '@shared/skill-types'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

// Mock the store
const mockFetchSkills = vi.fn()
const mockInstallSkill = vi.fn()
const mockUninstallSkill = vi.fn()

let mockStoreState = {
  skills: [] as SkillConfig[],
  categories: [] as SkillCategory[],
  loading: false,
  error: null as string | null,
  fetchSkills: mockFetchSkills,
  installSkill: mockInstallSkill,
  uninstallSkill: mockUninstallSkill
}

vi.mock('@/stores/skillStore', () => ({
  useSkillStore: () => mockStoreState
}))

beforeEach(() => {
  vi.clearAllMocks()
  mockStoreState = {
    skills: [],
    categories: [],
    loading: false,
    error: null,
    fetchSkills: mockFetchSkills,
    installSkill: mockInstallSkill,
    uninstallSkill: mockUninstallSkill
  }
})

afterEach(() => cleanup())

describe('Discover Page', () => {
  it('should render discover page with title', async () => {
    const { default: Discover } = await import('..')
    render(<Discover />)
    expect(screen.getByText('discover.title')).toBeTruthy()
  })

  it('should call fetchSkills on mount', async () => {
    const { default: Discover } = await import('..')
    render(<Discover />)
    expect(mockFetchSkills).toHaveBeenCalled()
  })

  it('should show loading state', async () => {
    mockStoreState = {
      ...mockStoreState,
      loading: true
    }

    const { default: Discover } = await import('..')
    render(<Discover />)
    expect(screen.getByText('discover.loading')).toBeTruthy()
  })

  it('should show error state', async () => {
    mockStoreState = {
      ...mockStoreState,
      error: 'Failed to fetch skills'
    }

    const { default: Discover } = await import('..')
    render(<Discover />)
    expect(screen.getByText('Failed to fetch skills')).toBeTruthy()
  })
})

describe('SkillList', () => {
  it('should render empty state when no skills', async () => {
    const { default: SkillList } = await import('../SkillList')
    render(
      <SkillList
        skills={[]}
        onSelect={vi.fn()}
        onInstall={vi.fn()}
        onUninstall={vi.fn()}
      />
    )
    expect(screen.getByText('discover.noSkills')).toBeTruthy()
  })

  it('should render skill list', async () => {
    const skills: SkillConfig[] = [
      {
        id: 'skill-1',
        name: 'Web Search',
        description: 'Search the web for information',
        version: '1.0.0',
        author: 'Echo',
        category: 'utility',
        isInstalled: false,
        isActive: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ]

    const { default: SkillList } = await import('../SkillList')
    render(
      <SkillList
        skills={skills}
        onSelect={vi.fn()}
        onInstall={vi.fn()}
        onUninstall={vi.fn()}
      />
    )
    expect(screen.getByText('Web Search')).toBeTruthy()
  })
})
