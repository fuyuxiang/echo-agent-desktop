import { describe, it, expect } from 'vitest'
import type { SoulConfig, SoulTemplate, SoulListResponse, SoulUpdateRequest, SoulAddRequest } from '../soul-types'

describe('Soul Types', () => {
  it('should define SoulConfig interface', () => {
    const soul: SoulConfig = {
      id: 'soul-1',
      name: 'Default Soul',
      content: '# My Soul\n\nI am a helpful assistant.',
      isActive: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    expect(soul).toBeDefined()
    expect(soul.id).toBe('soul-1')
    expect(soul.content).toContain('helpful assistant')
  })

  it('should define SoulTemplate interface', () => {
    const template: SoulTemplate = {
      id: 'template-1',
      name: 'Professional',
      content: '# Professional Assistant\n\nI am a professional assistant.',
      category: 'business'
    }
    expect(template).toBeDefined()
    expect(template.category).toBe('business')
  })

  it('should define SoulListResponse interface', () => {
    const response: SoulListResponse = {
      souls: [],
      templates: [],
      total: 0
    }
    expect(response).toBeDefined()
    expect(response.total).toBe(0)
  })

  it('should define SoulUpdateRequest interface', () => {
    const request: SoulUpdateRequest = {
      id: 'soul-1',
      name: 'Updated Soul',
      content: 'Updated content'
    }
    expect(request).toBeDefined()
    expect(request.id).toBe('soul-1')
  })

  it('should define SoulAddRequest interface', () => {
    const request: SoulAddRequest = {
      name: 'New Soul',
      content: 'New soul content'
    }
    expect(request).toBeDefined()
    expect(request.name).toBe('New Soul')
  })

  it('should allow optional fields in SoulConfig', () => {
    const soul: SoulConfig = {
      id: 'soul-2',
      name: 'Soul with Metadata',
      content: 'Content',
      isActive: false,
      metadata: { key: 'value' },
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z'
    }
    expect(soul.metadata).toEqual({ key: 'value' })
  })

  it('should allow optional fields in SoulTemplate', () => {
    const template: SoulTemplate = {
      id: 'template-2',
      name: 'Template with Description',
      content: 'Content',
      category: 'personal',
      description: 'A personal template'
    }
    expect(template.description).toBe('A personal template')
  })

  it('should allow optional fields in SoulUpdateRequest', () => {
    const request: SoulUpdateRequest = {
      id: 'soul-1'
    }
    expect(request.name).toBeUndefined()
    expect(request.content).toBeUndefined()
    expect(request.isActive).toBeUndefined()
    expect(request.metadata).toBeUndefined()
  })

  it('should allow optional metadata in SoulAddRequest', () => {
    const request: SoulAddRequest = {
      name: 'New Soul',
      content: 'Content',
      metadata: { tags: ['test'] }
    }
    expect(request.metadata).toEqual({ tags: ['test'] })
  })
})
