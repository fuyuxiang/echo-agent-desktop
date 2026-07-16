import { beforeEach, describe, expect, it, vi } from 'vitest'

const storeMock = vi.hoisted(() => {
  const data = new Map<string, unknown>()
  return {
    data,
    storeGet: vi.fn((key: string) => data.get(key)),
    storeSet: vi.fn((key: string, value: unknown) => { data.set(key, value) })
  }
})

vi.mock('../store', () => ({
  storeGet: storeMock.storeGet,
  storeSet: storeMock.storeSet
}))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  storeMock.data.clear()
})

describe('Gateway Management Service', () => {
  describe('listPlatforms', () => {
    it('should return predefined platforms', async () => {
      const { listPlatforms } = await import('../gateway')
      const result = await listPlatforms()
      expect(result).toBeDefined()
      expect(Array.isArray(result)).toBe(true)
      expect(result.length).toBeGreaterThan(0)
    })

    it('should include telegram platform', async () => {
      const { listPlatforms } = await import('../gateway')
      const result = await listPlatforms()
      const telegram = result.find(p => p.id === 'telegram')
      expect(telegram).toBeDefined()
      expect(telegram?.name).toBe('Telegram')
      expect(telegram?.type).toBe('messaging')
      expect(telegram?.isActive).toBe(true)
    })

    it('should include platforms of different types', async () => {
      const { listPlatforms } = await import('../gateway')
      const result = await listPlatforms()
      const types = new Set(result.map(p => p.type))
      expect(types.has('messaging')).toBe(true)
      expect(types.has('webhook')).toBe(true)
      expect(types.has('notification')).toBe(true)
    })
  })

  describe('listConfigs', () => {
    it('should return empty configs initially', async () => {
      const { listConfigs } = await import('../gateway')
      const result = await listConfigs()
      expect(result).toBeDefined()
      expect(Array.isArray(result.configs)).toBe(true)
      expect(Array.isArray(result.statuses)).toBe(true)
      expect(Array.isArray(result.platforms)).toBe(true)
      expect(result.configs).toHaveLength(0)
      expect(result.total).toBe(0)
    })

    it('should return added configs', async () => {
      const { addConfig, listConfigs } = await import('../gateway')
      await addConfig({ platformId: 'telegram', apiKey: 'test-key' })
      await addConfig({ platformId: 'discord', apiKey: 'discord-key' })

      const result = await listConfigs()
      expect(result.configs).toHaveLength(2)
      expect(result.total).toBe(2)
    })
  })

  describe('addConfig', () => {
    it('should add a new config', async () => {
      const { addConfig } = await import('../gateway')
      const result = await addConfig({
        platformId: 'telegram',
        apiKey: 'test-key'
      })
      expect(result).toBeDefined()
      expect(result.id).toBeDefined()
      expect(typeof result.id).toBe('string')
      expect(result.platformId).toBe('telegram')
      expect(result.apiKey).toBe('test-key')
      expect(result.isActive).toBe(true)
      expect(result.createdAt).toBeDefined()
      expect(result.updatedAt).toBeDefined()
    })

    it('should add config with webhook url', async () => {
      const { addConfig } = await import('../gateway')
      const result = await addConfig({
        platformId: 'webhook',
        webhookUrl: 'https://example.com/hook'
      })
      expect(result.platformId).toBe('webhook')
      expect(result.webhookUrl).toBe('https://example.com/hook')
      expect(result.apiKey).toBeUndefined()
    })

    it('should add config with metadata', async () => {
      const { addConfig } = await import('../gateway')
      const result = await addConfig({
        platformId: 'telegram',
        metadata: { chatId: '12345' }
      })
      expect(result.metadata).toEqual({ chatId: '12345' })
    })

    it('should generate unique ids for each config', async () => {
      const { addConfig } = await import('../gateway')
      const first = await addConfig({ platformId: 'telegram' })
      const second = await addConfig({ platformId: 'discord' })
      expect(first.id).not.toBe(second.id)
    })
  })

  describe('updateConfig', () => {
    it('should update an existing config', async () => {
      const { addConfig, updateConfig } = await import('../gateway')
      const added = await addConfig({ platformId: 'telegram', apiKey: 'old-key' })

      const updated = await updateConfig({
        id: added.id,
        apiKey: 'new-key'
      })
      expect(updated.id).toBe(added.id)
      expect(updated.apiKey).toBe('new-key')
      expect(updated.platformId).toBe('telegram')
    })

    it('should update webhook url', async () => {
      const { addConfig, updateConfig } = await import('../gateway')
      const added = await addConfig({ platformId: 'webhook', webhookUrl: 'https://old.com' })

      const updated = await updateConfig({
        id: added.id,
        webhookUrl: 'https://new.com'
      })
      expect(updated.webhookUrl).toBe('https://new.com')
    })

    it('should update isActive status', async () => {
      const { addConfig, updateConfig } = await import('../gateway')
      const added = await addConfig({ platformId: 'telegram' })
      expect(added.isActive).toBe(true)

      const updated = await updateConfig({ id: added.id, isActive: false })
      expect(updated.isActive).toBe(false)
    })

    it('should update metadata', async () => {
      const { addConfig, updateConfig } = await import('../gateway')
      const added = await addConfig({ platformId: 'telegram', metadata: { a: 1 } })

      const updated = await updateConfig({ id: added.id, metadata: { b: 2 } })
      expect(updated.metadata).toEqual({ b: 2 })
    })

    it('should update the updatedAt timestamp', async () => {
      const { addConfig, updateConfig } = await import('../gateway')
      const added = await addConfig({ platformId: 'telegram' })

      // Small delay to ensure different timestamp
      await new Promise(resolve => setTimeout(resolve, 10))
      const updated = await updateConfig({ id: added.id, apiKey: 'x' })
      expect(updated.updatedAt).not.toBe(added.updatedAt)
    })

    it('should throw for non-existent config', async () => {
      const { updateConfig } = await import('../gateway')
      await expect(
        updateConfig({ id: 'non-existent-id', apiKey: 'x' })
      ).rejects.toThrow('Config not found: non-existent-id')
    })
  })

  describe('removeConfig', () => {
    it('should remove an existing config', async () => {
      const { addConfig, removeConfig, listConfigs } = await import('../gateway')
      const added = await addConfig({ platformId: 'telegram' })

      await removeConfig(added.id)
      const remaining = await listConfigs()
      expect(remaining.configs.find(c => c.id === added.id)).toBeUndefined()
      expect(remaining.total).toBe(0)
    })

    it('should not throw when removing non-existent config', async () => {
      const { removeConfig } = await import('../gateway')
      await expect(removeConfig('non-existent-id')).resolves.toBeUndefined()
    })

    it('should only remove the specified config', async () => {
      const { addConfig, removeConfig, listConfigs } = await import('../gateway')
      const first = await addConfig({ platformId: 'telegram' })
      const second = await addConfig({ platformId: 'discord' })

      await removeConfig(first.id)
      const remaining = await listConfigs()
      expect(remaining.configs).toHaveLength(1)
      expect(remaining.configs[0].id).toBe(second.id)
    })
  })

  describe('getStatus', () => {
    it('should return disconnected status for unknown platform', async () => {
      const { getStatus } = await import('../gateway')
      const status = await getStatus('telegram')
      expect(status).toBeDefined()
      expect(status.platformId).toBe('telegram')
      expect(status.isConnected).toBe(false)
      expect(status.errorCount).toBe(0)
    })

    it('should return stored status when available', async () => {
      storeMock.data.set('gateway.statuses', [
        { platformId: 'telegram', isConnected: true, lastConnectedAt: '2025-01-01T00:00:00Z', errorCount: 0 }
      ])
      const { getStatus } = await import('../gateway')
      const status = await getStatus('telegram')
      expect(status.isConnected).toBe(true)
      expect(status.lastConnectedAt).toBe('2025-01-01T00:00:00Z')
    })

    it('should return default status for platform not in stored statuses', async () => {
      storeMock.data.set('gateway.statuses', [
        { platformId: 'discord', isConnected: true, errorCount: 0 }
      ])
      const { getStatus } = await import('../gateway')
      const status = await getStatus('telegram')
      expect(status.platformId).toBe('telegram')
      expect(status.isConnected).toBe(false)
    })
  })

  describe('testConnection', () => {
    it('should return success result', async () => {
      const { testConnection } = await import('../gateway')
      const result = await testConnection({ platformId: 'telegram' })
      expect(result).toBeDefined()
      expect(typeof result.success).toBe('boolean')
      expect(result.success).toBe(true)
      expect(result.message).toBeDefined()
      expect(typeof result.latency).toBe('number')
    })

    it('should include latency measurement', async () => {
      const { testConnection } = await import('../gateway')
      const result = await testConnection({ platformId: 'discord' })
      expect(result.latency).toBeGreaterThanOrEqual(0)
    })

    it('should accept optional message parameter', async () => {
      const { testConnection } = await import('../gateway')
      const result = await testConnection({ platformId: 'telegram', message: 'hello' })
      expect(result.success).toBe(true)
    })
  })

  describe('sendMessage', () => {
    it('should send a message and return it', async () => {
      const { sendMessage } = await import('../gateway')
      const result = await sendMessage({
        platformId: 'telegram',
        content: 'Hello World'
      })
      expect(result).toBeDefined()
      expect(result.id).toBeDefined()
      expect(result.platformId).toBe('telegram')
      expect(result.direction).toBe('outbound')
      expect(result.content).toBe('Hello World')
      expect(result.timestamp).toBeDefined()
    })

    it('should store sent messages', async () => {
      const { sendMessage, listMessages } = await import('../gateway')
      await sendMessage({ platformId: 'telegram', content: 'msg1' })
      await sendMessage({ platformId: 'discord', content: 'msg2' })

      const messages = await listMessages()
      expect(messages).toHaveLength(2)
    })

    it('should filter messages by platformId', async () => {
      const { sendMessage, listMessages } = await import('../gateway')
      await sendMessage({ platformId: 'telegram', content: 'msg1' })
      await sendMessage({ platformId: 'discord', content: 'msg2' })

      const telegramMessages = await listMessages('telegram')
      expect(telegramMessages).toHaveLength(1)
      expect(telegramMessages[0].platformId).toBe('telegram')
    })

    it('should include metadata when provided', async () => {
      const { sendMessage } = await import('../gateway')
      const result = await sendMessage({
        platformId: 'telegram',
        content: 'Hello',
        metadata: { chatId: '123' }
      })
      expect(result.metadata).toEqual({ chatId: '123' })
    })
  })
})
