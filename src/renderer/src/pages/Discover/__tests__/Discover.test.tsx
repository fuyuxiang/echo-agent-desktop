// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkillConfig } from '@shared/skill-types'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

// Mock skillsAPI - the Discover page now uses this instead of useSkillStore
const mockSkillsList = vi.fn(async () => ({
  skills: [{ id: 'ppt', label: 'PPT', description: 'A presentation skill', kind: 'code' as const }]
}))

vi.mock('@/services/agent/skills', () => ({
  skillsAPI: {
    list: mockSkillsList
  }
}))

beforeEach(() => {
  vi.clearAllMocks()
  mockSkillsList.mockResolvedValue({
    skills: [{ id: 'ppt', label: 'PPT', description: 'A presentation skill', kind: 'code' as const }]
  })
})

afterEach(() => cleanup())

describe('Discover Page', () => {
  it('should render discover page with title', async () => {
    const { default: Discover } = await import('..')
    render(<Discover />)
    expect(screen.getByText('discover.title')).toBeTruthy()
  })

  it('should call skillsAPI.list on mount', async () => {
    const { default: Discover } = await import('..')
    render(<Discover />)
    await waitFor(() => {
      expect(mockSkillsList).toHaveBeenCalled()
    })
  })

  it('should show loading state', async () => {
    // Make the API return a never-resolving promise to keep loading state
    mockSkillsList.mockReturnValue(new Promise(() => {}))

    const { default: Discover } = await import('..')
    render(<Discover />)
    expect(screen.getByText('discover.loading')).toBeTruthy()
  })

  it('should show error state', async () => {
    mockSkillsList.mockRejectedValue(new Error('Failed to fetch skills'))

    const { default: Discover } = await import('..')
    render(<Discover />)
    await waitFor(() => {
      expect(screen.getByText('Failed to fetch skills')).toBeTruthy()
    })
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
