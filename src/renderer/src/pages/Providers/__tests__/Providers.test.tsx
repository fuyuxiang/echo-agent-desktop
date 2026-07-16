// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderConfig } from '@shared/provider-types'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

// Mock the store
const mockFetchProviders = vi.fn()
const mockAddProvider = vi.fn()
const mockUpdateProvider = vi.fn()
const mockRemoveProvider = vi.fn()
const mockTestProvider = vi.fn()

let mockStoreState = {
  providers: [] as ProviderConfig[],
  loading: false,
  error: null as string | null,
  fetchProviders: mockFetchProviders,
  addProvider: mockAddProvider,
  updateProvider: mockUpdateProvider,
  removeProvider: mockRemoveProvider,
  testProvider: mockTestProvider
}

vi.mock('@/stores/providerStore', () => ({
  useProviderStore: () => mockStoreState
}))

beforeEach(() => {
  vi.clearAllMocks()
  mockStoreState = {
    providers: [],
    loading: false,
    error: null,
    fetchProviders: mockFetchProviders,
    addProvider: mockAddProvider,
    updateProvider: mockUpdateProvider,
    removeProvider: mockRemoveProvider,
    testProvider: mockTestProvider
  }
})

afterEach(() => cleanup())

describe('Providers Page', () => {
  it('should render providers page with title', async () => {
    const { default: Providers } = await import('..')
    render(<Providers />)
    expect(screen.getByText('providers.title')).toBeTruthy()
  })

  it('should show add provider button', async () => {
    const { default: Providers } = await import('..')
    render(<Providers />)
    expect(screen.getByText('providers.addProvider')).toBeTruthy()
  })

  it('should show empty state when no providers', async () => {
    const { default: Providers } = await import('..')
    render(<Providers />)
    expect(screen.getByText('providers.noProviders')).toBeTruthy()
  })

  it('should call fetchProviders on mount', async () => {
    const { default: Providers } = await import('..')
    render(<Providers />)
    expect(mockFetchProviders).toHaveBeenCalled()
  })

  it('should show loading state', async () => {
    mockStoreState = {
      ...mockStoreState,
      loading: true
    }

    const { default: Providers } = await import('..')
    render(<Providers />)
    expect(screen.getByText('providers.loading')).toBeTruthy()
  })

  it('should show error state', async () => {
    mockStoreState = {
      ...mockStoreState,
      error: 'Failed to fetch providers'
    }

    const { default: Providers } = await import('..')
    render(<Providers />)
    expect(screen.getByText('Failed to fetch providers')).toBeTruthy()
  })
})

describe('ProviderList', () => {
  it('should render empty state when no providers', async () => {
    const { default: ProviderList } = await import('../ProviderList')
    render(
      <ProviderList
        providers={[]}
        onEdit={vi.fn()}
        onRemove={vi.fn()}
        onTest={vi.fn()}
      />
    )
    expect(screen.getByText('providers.noProviders')).toBeTruthy()
  })

  it('should render provider list', async () => {
    const { default: ProviderList } = await import('../ProviderList')
    const providers = [
      {
        id: '1',
        name: 'OpenAI',
        type: 'openai',
        isActive: true,
        models: ['gpt-4', 'gpt-3.5-turbo'],
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01'
      },
      {
        id: '2',
        name: 'Anthropic',
        type: 'anthropic',
        isActive: true,
        models: ['claude-3'],
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01'
      }
    ]

    render(
      <ProviderList
        providers={providers}
        onEdit={vi.fn()}
        onRemove={vi.fn()}
        onTest={vi.fn()}
      />
    )

    expect(screen.getByText('OpenAI')).toBeTruthy()
    expect(screen.getByText('Anthropic')).toBeTruthy()
    expect(screen.getByText(/openai.*2.*providers\.models/)).toBeTruthy()
    expect(screen.getByText(/anthropic.*1.*providers\.models/)).toBeTruthy()
  })

  it('should show edit, remove and test buttons for each provider', async () => {
    const { default: ProviderList } = await import('../ProviderList')
    const providers = [
      {
        id: '1',
        name: 'OpenAI',
        type: 'openai',
        isActive: true,
        models: ['gpt-4'],
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01'
      }
    ]

    render(
      <ProviderList
        providers={providers}
        onEdit={vi.fn()}
        onRemove={vi.fn()}
        onTest={vi.fn()}
      />
    )

    expect(screen.getByText('providers.test')).toBeTruthy()
    expect(screen.getByText('providers.edit')).toBeTruthy()
    expect(screen.getByText('providers.remove')).toBeTruthy()
  })
})

describe('ProviderForm', () => {
  it('should render add form when no provider provided', async () => {
    const { default: ProviderForm } = await import('../ProviderForm')
    render(<ProviderForm onSubmit={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByText('providers.addProvider')).toBeTruthy()
    expect(screen.getByText('providers.add')).toBeTruthy()
  })

  it('should render edit form when provider provided', async () => {
    const { default: ProviderForm } = await import('../ProviderForm')
    const provider = {
      id: '1',
      name: 'OpenAI',
      type: 'openai',
      isActive: true,
      models: ['gpt-4'],
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01'
    }

    render(<ProviderForm provider={provider} onSubmit={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByText('providers.editProvider')).toBeTruthy()
    expect(screen.getByText('providers.update')).toBeTruthy()
  })

  it('should have form fields', async () => {
    const { default: ProviderForm } = await import('../ProviderForm')
    render(<ProviderForm onSubmit={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByLabelText('providers.name')).toBeTruthy()
    expect(screen.getByLabelText('providers.type')).toBeTruthy()
    expect(screen.getByLabelText('providers.apiKey')).toBeTruthy()
    expect(screen.getByLabelText('providers.baseUrl')).toBeTruthy()
    expect(screen.getByLabelText('providers.description')).toBeTruthy()
  })

  it('should have cancel button', async () => {
    const { default: ProviderForm } = await import('../ProviderForm')
    render(<ProviderForm onSubmit={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByText('providers.cancel')).toBeTruthy()
  })
})
