// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SoulConfig } from '@shared/soul-types'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

// Mock the store
const mockFetchSouls = vi.fn()
const mockAddSoul = vi.fn()
const mockUpdateSoul = vi.fn()
const mockDeleteSoul = vi.fn()
const mockSetActiveSoul = vi.fn()

let mockStoreState = {
  souls: [] as SoulConfig[],
  activeSoul: null as SoulConfig | null,
  loading: false,
  error: null as string | null,
  fetchSouls: mockFetchSouls,
  addSoul: mockAddSoul,
  updateSoul: mockUpdateSoul,
  deleteSoul: mockDeleteSoul,
  setActiveSoul: mockSetActiveSoul
}

vi.mock('@/stores/soulStore', () => ({
  useSoulStore: () => mockStoreState
}))

beforeEach(() => {
  vi.clearAllMocks()
  mockStoreState = {
    souls: [],
    activeSoul: null,
    loading: false,
    error: null,
    fetchSouls: mockFetchSouls,
    addSoul: mockAddSoul,
    updateSoul: mockUpdateSoul,
    deleteSoul: mockDeleteSoul,
    setActiveSoul: mockSetActiveSoul
  }
})

afterEach(() => cleanup())

describe('Soul Page', () => {
  it('should render soul page with title', async () => {
    const { default: Soul } = await import('..')
    render(<Soul />)
    expect(screen.getByText('soul.title')).toBeTruthy()
  })

  it('should show add soul button', async () => {
    const { default: Soul } = await import('..')
    render(<Soul />)
    expect(screen.getByText('soul.addSoul')).toBeTruthy()
  })

  it('should call fetchSouls on mount', async () => {
    const { default: Soul } = await import('..')
    render(<Soul />)
    expect(mockFetchSouls).toHaveBeenCalled()
  })

  it('should show loading state', async () => {
    mockStoreState = {
      ...mockStoreState,
      loading: true
    }

    const { default: Soul } = await import('..')
    render(<Soul />)
    expect(screen.getByText('soul.loading')).toBeTruthy()
  })

  it('should show error state', async () => {
    mockStoreState = {
      ...mockStoreState,
      error: 'Failed to fetch souls'
    }

    const { default: Soul } = await import('..')
    render(<Soul />)
    expect(screen.getByText('Failed to fetch souls')).toBeTruthy()
  })

  it('should show empty state when no souls', async () => {
    const { default: Soul } = await import('..')
    render(<Soul />)
    expect(screen.getByText('soul.noSouls')).toBeTruthy()
  })

  it('should render soul list', async () => {
    const souls: SoulConfig[] = [
      {
        id: 'soul-1',
        name: 'Default Soul',
        content: 'I am a helpful assistant.',
        isActive: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ]

    mockStoreState = {
      ...mockStoreState,
      souls
    }

    const { default: Soul } = await import('..')
    render(<Soul />)
    expect(screen.getByText('Default Soul')).toBeTruthy()
  })
})
