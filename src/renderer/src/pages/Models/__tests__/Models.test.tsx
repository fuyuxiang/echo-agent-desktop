// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelConfig } from '@shared/model-types'

// Mock the store
const mockFetchModels = vi.fn()
const mockAddModel = vi.fn()
const mockUpdateModel = vi.fn()
const mockRemoveModel = vi.fn()
const mockSetActiveModel = vi.fn()

let mockStoreState = {
  models: [] as ModelConfig[],
  activeModel: null as ModelConfig | null,
  loading: false,
  error: null as string | null,
  fetchModels: mockFetchModels,
  addModel: mockAddModel,
  updateModel: mockUpdateModel,
  removeModel: mockRemoveModel,
  setActiveModel: mockSetActiveModel
}

vi.mock('@/stores/modelStore', () => ({
  useModelStore: () => mockStoreState
}))

beforeEach(() => {
  vi.clearAllMocks()
  mockStoreState = {
    models: [],
    activeModel: null,
    loading: false,
    error: null,
    fetchModels: mockFetchModels,
    addModel: mockAddModel,
    updateModel: mockUpdateModel,
    removeModel: mockRemoveModel,
    setActiveModel: mockSetActiveModel
  }
})

afterEach(() => cleanup())

describe('Models Page', () => {
  it('should render models page with title', async () => {
    const { default: Models } = await import('..')
    render(<Models />)
    expect(screen.getByText('Models')).toBeTruthy()
  })

  it('should show add model button', async () => {
    const { default: Models } = await import('..')
    render(<Models />)
    expect(screen.getByText('Add Model')).toBeTruthy()
  })

  it('should show empty state when no models', async () => {
    const { default: Models } = await import('..')
    render(<Models />)
    expect(screen.getByText('No models configured')).toBeTruthy()
  })

  it('should call fetchModels on mount', async () => {
    const { default: Models } = await import('..')
    render(<Models />)
    expect(mockFetchModels).toHaveBeenCalled()
  })

  it('should show loading state', async () => {
    mockStoreState = {
      ...mockStoreState,
      loading: true
    }

    const { default: Models } = await import('..')
    render(<Models />)
    expect(screen.getByText('Loading...')).toBeTruthy()
  })

  it('should show error state', async () => {
    mockStoreState = {
      ...mockStoreState,
      error: 'Failed to fetch models'
    }

    const { default: Models } = await import('..')
    render(<Models />)
    expect(screen.getByText('Failed to fetch models')).toBeTruthy()
  })
})

describe('ModelList', () => {
  it('should render empty state when no models', async () => {
    const { default: ModelList } = await import('../ModelList')
    render(
      <ModelList
        models={[]}
        activeModel={null}
        onEdit={vi.fn()}
        onRemove={vi.fn()}
        onSetActive={vi.fn()}
      />
    )
    expect(screen.getByText('No models configured')).toBeTruthy()
  })

  it('should render model list', async () => {
    const { default: ModelList } = await import('../ModelList')
    const models = [
      {
        id: '1',
        name: 'GPT-4',
        provider: 'openai',
        contextWindow: 128000,
        maxTokens: 4096,
        isActive: true,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01'
      },
      {
        id: '2',
        name: 'Claude 3',
        provider: 'anthropic',
        contextWindow: 200000,
        maxTokens: 4096,
        isActive: false,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01'
      }
    ]

    render(
      <ModelList
        models={models}
        activeModel={models[0]}
        onEdit={vi.fn()}
        onRemove={vi.fn()}
        onSetActive={vi.fn()}
      />
    )

    expect(screen.getByText('GPT-4')).toBeTruthy()
    expect(screen.getByText('Claude 3')).toBeTruthy()
    expect(screen.getByText('openai • 128,000 tokens')).toBeTruthy()
    expect(screen.getByText('anthropic • 200,000 tokens')).toBeTruthy()
  })

  it('should show edit and remove buttons for each model', async () => {
    const { default: ModelList } = await import('../ModelList')
    const models = [
      {
        id: '1',
        name: 'GPT-4',
        provider: 'openai',
        contextWindow: 128000,
        maxTokens: 4096,
        isActive: true,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01'
      }
    ]

    render(
      <ModelList
        models={models}
        activeModel={models[0]}
        onEdit={vi.fn()}
        onRemove={vi.fn()}
        onSetActive={vi.fn()}
      />
    )

    expect(screen.getByText('Edit')).toBeTruthy()
    expect(screen.getByText('Remove')).toBeTruthy()
  })

  it('should show Set Active button for inactive models', async () => {
    const { default: ModelList } = await import('../ModelList')
    const models = [
      {
        id: '1',
        name: 'GPT-4',
        provider: 'openai',
        contextWindow: 128000,
        maxTokens: 4096,
        isActive: false,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01'
      }
    ]

    render(
      <ModelList
        models={models}
        activeModel={null}
        onEdit={vi.fn()}
        onRemove={vi.fn()}
        onSetActive={vi.fn()}
      />
    )

    expect(screen.getByText('Set Active')).toBeTruthy()
  })

  it('should not show Set Active button for active model', async () => {
    const { default: ModelList } = await import('../ModelList')
    const models = [
      {
        id: '1',
        name: 'GPT-4',
        provider: 'openai',
        contextWindow: 128000,
        maxTokens: 4096,
        isActive: true,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01'
      }
    ]

    render(
      <ModelList
        models={models}
        activeModel={models[0]}
        onEdit={vi.fn()}
        onRemove={vi.fn()}
        onSetActive={vi.fn()}
      />
    )

    expect(screen.queryByText('Set Active')).toBeNull()
  })
})

describe('ModelForm', () => {
  it('should render add form when no model provided', async () => {
    const { default: ModelForm } = await import('../ModelForm')
    render(<ModelForm onSubmit={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByText('Add Model')).toBeTruthy()
    expect(screen.getByText('Add')).toBeTruthy()
  })

  it('should render edit form when model provided', async () => {
    const { default: ModelForm } = await import('../ModelForm')
    const model = {
      id: '1',
      name: 'GPT-4',
      provider: 'openai',
      contextWindow: 128000,
      maxTokens: 4096,
      isActive: true,
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01'
    }

    render(<ModelForm model={model} onSubmit={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByText('Edit Model')).toBeTruthy()
    expect(screen.getByText('Update')).toBeTruthy()
  })

  it('should have form fields', async () => {
    const { default: ModelForm } = await import('../ModelForm')
    render(<ModelForm onSubmit={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByLabelText('Name')).toBeTruthy()
    expect(screen.getByLabelText('Provider')).toBeTruthy()
    expect(screen.getByLabelText('Context Window')).toBeTruthy()
    expect(screen.getByLabelText('Max Tokens')).toBeTruthy()
  })

  it('should have cancel button', async () => {
    const { default: ModelForm } = await import('../ModelForm')
    render(<ModelForm onSubmit={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByText('Cancel')).toBeTruthy()
  })
})
