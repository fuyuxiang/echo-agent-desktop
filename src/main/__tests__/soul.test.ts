import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock the store module
vi.mock('../store', () => ({
  storeGet: vi.fn(),
  storeSet: vi.fn()
}))

import {
  listSouls,
  getSoul,
  addSoul,
  updateSoul,
  deleteSoul,
  setActiveSoul,
  addTemplate,
  updateTemplate,
  deleteTemplate
} from '../soul'
import { storeGet, storeSet } from '../store'

const mockStoreGet = vi.mocked(storeGet)
const mockStoreSet = vi.mocked(storeSet)

describe('Soul Management Service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockStoreGet.mockReturnValue([])
  })

  describe('listSouls', () => {
    it('should return empty list when no souls', async () => {
      const result = await listSouls()
      expect(result.souls).toEqual([])
      expect(result.total).toBe(0)
    })

    it('should return added souls', async () => {
      const soul = await addSoul({ name: 'Test Soul', content: 'Test content' })
      mockStoreGet.mockReturnValue([soul])
      const result = await listSouls()
      expect(result.souls).toHaveLength(1)
      expect(result.total).toBe(1)
    })

    it('should return default templates when no custom templates', async () => {
      // Mock storeGet to return undefined for templates (triggers default)
      mockStoreGet.mockImplementation((key: string) => {
        if (key === 'soul.templates') return undefined
        return []
      })
      const result = await listSouls()
      expect(result.templates).toHaveLength(3)
      expect(result.templates[0].name).toBe('Default Assistant')
    })
  })

  describe('getSoul', () => {
    it('should throw for non-existent soul', async () => {
      await expect(getSoul('non-existent')).rejects.toThrow('Soul not found: non-existent')
    })

    it('should return existing soul', async () => {
      const soul = await addSoul({ name: 'Test Soul', content: 'Test content' })
      mockStoreGet.mockReturnValue([soul])
      const result = await getSoul(soul.id)
      expect(result.name).toBe('Test Soul')
    })
  })

  describe('addSoul', () => {
    it('should add a new soul', async () => {
      const result = await addSoul({ name: 'New Soul', content: 'Soul content' })
      expect(result.name).toBe('New Soul')
      expect(result.content).toBe('Soul content')
      expect(result.isActive).toBe(false)
      expect(mockStoreSet).toHaveBeenCalled()
    })

    it('should add soul with metadata', async () => {
      const result = await addSoul({
        name: 'Soul with Metadata',
        content: 'Content',
        metadata: { key: 'value' }
      })
      expect(result.metadata).toEqual({ key: 'value' })
    })
  })

  describe('updateSoul', () => {
    it('should throw for non-existent soul', async () => {
      await expect(updateSoul({ id: 'non-existent', name: 'Updated' })).rejects.toThrow('Soul not found: non-existent')
    })

    it('should update an existing soul', async () => {
      const soul = await addSoul({ name: 'Original', content: 'Content' })
      mockStoreGet.mockReturnValue([soul])
      const result = await updateSoul({ id: soul.id, name: 'Updated' })
      expect(result.name).toBe('Updated')
      expect(mockStoreSet).toHaveBeenCalled()
    })

    it('should update soul content', async () => {
      const soul = await addSoul({ name: 'Soul', content: 'Original' })
      mockStoreGet.mockReturnValue([soul])
      const result = await updateSoul({ id: soul.id, content: 'Updated content' })
      expect(result.content).toBe('Updated content')
    })
  })

  describe('deleteSoul', () => {
    it('should delete an existing soul', async () => {
      const soul = await addSoul({ name: 'To Delete', content: 'Content' })
      mockStoreGet.mockReturnValue([soul])
      await deleteSoul(soul.id)
      expect(mockStoreSet).toHaveBeenCalledWith('soul.configs', [])
    })

    it('should not throw when deleting non-existent soul', async () => {
      await expect(deleteSoul('non-existent')).resolves.not.toThrow()
    })
  })

  describe('setActiveSoul', () => {
    it('should throw for non-existent soul', async () => {
      await expect(setActiveSoul('non-existent')).rejects.toThrow('Soul not found: non-existent')
    })

    it('should set soul as active', async () => {
      const soul = await addSoul({ name: 'Soul', content: 'Content' })
      mockStoreGet.mockReturnValue([soul])
      const result = await setActiveSoul(soul.id)
      expect(result.isActive).toBe(true)
      expect(mockStoreSet).toHaveBeenCalled()
    })

    it('should deactivate other souls when setting active', async () => {
      const soul1 = await addSoul({ name: 'Soul 1', content: 'Content 1' })
      const soul2 = await addSoul({ name: 'Soul 2', content: 'Content 2' })
      mockStoreGet.mockReturnValue([
        { ...soul1, isActive: true },
        soul2
      ])
      const result = await setActiveSoul(soul2.id)
      expect(result.isActive).toBe(true)
    })
  })

  describe('addTemplate', () => {
    it('should add a new template', async () => {
      const result = await addTemplate({
        name: 'Custom Template',
        content: 'Template content',
        category: 'custom'
      })
      expect(result.name).toBe('Custom Template')
      expect(result.category).toBe('custom')
      expect(mockStoreSet).toHaveBeenCalled()
    })

    it('should add template with description', async () => {
      const result = await addTemplate({
        name: 'Template',
        content: 'Content',
        category: 'test',
        description: 'Template description'
      })
      expect(result.description).toBe('Template description')
    })
  })

  describe('updateTemplate', () => {
    it('should throw for non-existent template', async () => {
      await expect(updateTemplate({ id: 'non-existent', name: 'Updated' })).rejects.toThrow('Template not found: non-existent')
    })

    it('should update an existing template', async () => {
      mockStoreGet.mockReturnValue([
        { id: 'template-1', name: 'Original', content: 'Content', category: 'test' }
      ])
      const result = await updateTemplate({ id: 'template-1', name: 'Updated' })
      expect(result.name).toBe('Updated')
      expect(mockStoreSet).toHaveBeenCalled()
    })
  })

  describe('deleteTemplate', () => {
    it('should delete an existing template', async () => {
      mockStoreGet.mockReturnValue([
        { id: 'template-1', name: 'Template', content: 'Content', category: 'test' }
      ])
      await deleteTemplate('template-1')
      expect(mockStoreSet).toHaveBeenCalledWith('soul.templates', [])
    })

    it('should not throw when deleting non-existent template', async () => {
      await expect(deleteTemplate('non-existent')).resolves.not.toThrow()
    })
  })
})
