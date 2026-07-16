// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GatewayPlatform, GatewayConfig, GatewayStatus } from '@shared/gateway-types'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

// Mock the store
const mockFetchPlatforms = vi.fn()
const mockFetchConfigs = vi.fn()
const mockAddConfig = vi.fn()
const mockUpdateConfig = vi.fn()
const mockRemoveConfig = vi.fn()
const mockTestConnection = vi.fn()

let mockStoreState = {
  platforms: [] as GatewayPlatform[],
  configs: [] as GatewayConfig[],
  statuses: [] as GatewayStatus[],
  loading: false,
  error: null as string | null,
  fetchPlatforms: mockFetchPlatforms,
  fetchConfigs: mockFetchConfigs,
  addConfig: mockAddConfig,
  updateConfig: mockUpdateConfig,
  removeConfig: mockRemoveConfig,
  testConnection: mockTestConnection
}

vi.mock('@/stores/gatewayStore', () => ({
  useGatewayStore: () => mockStoreState
}))

beforeEach(() => {
  vi.clearAllMocks()
  mockStoreState = {
    platforms: [],
    configs: [],
    statuses: [],
    loading: false,
    error: null,
    fetchPlatforms: mockFetchPlatforms,
    fetchConfigs: mockFetchConfigs,
    addConfig: mockAddConfig,
    updateConfig: mockUpdateConfig,
    removeConfig: mockRemoveConfig,
    testConnection: mockTestConnection
  }
})

afterEach(() => cleanup())

describe('Gateway Page', () => {
  it('should render gateway page with title', async () => {
    const { default: Gateway } = await import('..')
    render(<Gateway />)
    expect(screen.getByText('gateway.title')).toBeTruthy()
  })

  it('should show add config button', async () => {
    const { default: Gateway } = await import('..')
    render(<Gateway />)
    expect(screen.getByText('gateway.addConfig')).toBeTruthy()
  })

  it('should call fetchPlatforms and fetchConfigs on mount', async () => {
    const { default: Gateway } = await import('..')
    render(<Gateway />)
    expect(mockFetchPlatforms).toHaveBeenCalled()
    expect(mockFetchConfigs).toHaveBeenCalled()
  })

  it('should show loading state', async () => {
    mockStoreState = {
      ...mockStoreState,
      loading: true
    }

    const { default: Gateway } = await import('..')
    render(<Gateway />)
    expect(screen.getByText('gateway.loading')).toBeTruthy()
  })

  it('should show error state', async () => {
    mockStoreState = {
      ...mockStoreState,
      error: 'Failed to fetch platforms'
    }

    const { default: Gateway } = await import('..')
    render(<Gateway />)
    expect(screen.getByText('Failed to fetch platforms')).toBeTruthy()
  })
})

describe('PlatformList', () => {
  it('should render empty state when no platforms', async () => {
    const { default: PlatformList } = await import('../PlatformList')
    render(
      <PlatformList
        platforms={[]}
        configs={[]}
        statuses={[]}
        onEdit={vi.fn()}
        onRemove={vi.fn()}
        onTest={vi.fn()}
      />
    )
    expect(screen.getByText('gateway.noPlatforms')).toBeTruthy()
  })

  it('should render platform list', async () => {
    const platforms: GatewayPlatform[] = [
      {
        id: 'telegram',
        name: 'Telegram',
        type: 'messaging',
        isActive: true,
        config: {}
      }
    ]

    const { default: PlatformList } = await import('../PlatformList')
    render(
      <PlatformList
        platforms={platforms}
        configs={[]}
        statuses={[]}
        onEdit={vi.fn()}
        onRemove={vi.fn()}
        onTest={vi.fn()}
      />
    )
    expect(screen.getByText('Telegram')).toBeTruthy()
  })
})
