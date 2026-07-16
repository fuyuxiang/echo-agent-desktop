import { describe, it, expect } from 'vitest'
import type {
  SessionConfig,
  SessionMessage,
  SessionListResponse,
  SessionSearchRequest,
  SessionSearchResponse,
  SessionExportData,
  SessionImportData,
  SessionUpdateRequest
} from '../session-types'

describe('Session Types', () => {
  it('should define SessionConfig interface', () => {
    const session: SessionConfig = {
      id: 'session-1',
      title: 'Test Session',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: 10,
      isActive: true
    }
    expect(session).toBeDefined()
    expect(session.id).toBe('session-1')
    expect(session.title).toBe('Test Session')
    expect(session.messageCount).toBe(10)
    expect(session.isActive).toBe(true)
  })

  it('should support optional metadata in SessionConfig', () => {
    const session: SessionConfig = {
      id: 'session-2',
      title: 'Session with Metadata',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: 5,
      isActive: false,
      metadata: { source: 'import', tags: ['test'] }
    }
    expect(session.metadata).toBeDefined()
    expect(session.metadata?.source).toBe('import')
  })

  it('should define SessionMessage interface', () => {
    const message: SessionMessage = {
      id: 'msg-1',
      sessionId: 'session-1',
      role: 'user',
      content: 'Hello',
      timestamp: new Date().toISOString()
    }
    expect(message).toBeDefined()
    expect(message.role).toBe('user')
    expect(message.content).toBe('Hello')
  })

  it('should support all message roles', () => {
    const userMsg: SessionMessage = {
      id: 'msg-1',
      sessionId: 'session-1',
      role: 'user',
      content: 'User message',
      timestamp: new Date().toISOString()
    }
    const assistantMsg: SessionMessage = {
      id: 'msg-2',
      sessionId: 'session-1',
      role: 'assistant',
      content: 'Assistant message',
      timestamp: new Date().toISOString()
    }
    const systemMsg: SessionMessage = {
      id: 'msg-3',
      sessionId: 'session-1',
      role: 'system',
      content: 'System message',
      timestamp: new Date().toISOString()
    }
    expect(userMsg.role).toBe('user')
    expect(assistantMsg.role).toBe('assistant')
    expect(systemMsg.role).toBe('system')
  })

  it('should support optional metadata in SessionMessage', () => {
    const message: SessionMessage = {
      id: 'msg-4',
      sessionId: 'session-1',
      role: 'assistant',
      content: 'Response',
      timestamp: new Date().toISOString(),
      metadata: { model: 'gpt-4', tokens: 150 }
    }
    expect(message.metadata?.model).toBe('gpt-4')
    expect(message.metadata?.tokens).toBe(150)
  })

  it('should define SessionListResponse interface', () => {
    const response: SessionListResponse = {
      sessions: [],
      total: 0,
      groupedByDate: {
        today: [],
        yesterday: [],
        thisWeek: [],
        older: []
      }
    }
    expect(response).toBeDefined()
    expect(response.total).toBe(0)
    expect(response.sessions).toEqual([])
    expect(response.groupedByDate.today).toEqual([])
    expect(response.groupedByDate.yesterday).toEqual([])
    expect(response.groupedByDate.thisWeek).toEqual([])
    expect(response.groupedByDate.older).toEqual([])
  })

  it('should define SessionSearchRequest interface', () => {
    const request: SessionSearchRequest = {
      query: 'test search'
    }
    expect(request).toBeDefined()
    expect(request.query).toBe('test search')
  })

  it('should support optional limit and offset in SessionSearchRequest', () => {
    const request: SessionSearchRequest = {
      query: 'search',
      limit: 20,
      offset: 10
    }
    expect(request.limit).toBe(20)
    expect(request.offset).toBe(10)
  })

  it('should define SessionSearchResponse interface', () => {
    const response: SessionSearchResponse = {
      results: [],
      total: 0,
      query: 'test'
    }
    expect(response).toBeDefined()
    expect(response.results).toEqual([])
    expect(response.total).toBe(0)
    expect(response.query).toBe('test')
  })

  it('should define SessionExportData interface', () => {
    const exportData: SessionExportData = {
      session: {
        id: 'session-1',
        title: 'Export Session',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageCount: 2,
        isActive: true
      },
      messages: [
        {
          id: 'msg-1',
          sessionId: 'session-1',
          role: 'user',
          content: 'Hello',
          timestamp: new Date().toISOString()
        },
        {
          id: 'msg-2',
          sessionId: 'session-1',
          role: 'assistant',
          content: 'Hi there',
          timestamp: new Date().toISOString()
        }
      ],
      exportedAt: new Date().toISOString(),
      version: '1.0.0'
    }
    expect(exportData).toBeDefined()
    expect(exportData.session.id).toBe('session-1')
    expect(exportData.messages).toHaveLength(2)
    expect(exportData.version).toBe('1.0.0')
  })

  it('should define SessionImportData interface', () => {
    const importData: SessionImportData = {
      session: {
        id: 'session-imported',
        title: 'Imported Session',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageCount: 1,
        isActive: true
      },
      messages: [
        {
          id: 'msg-1',
          sessionId: 'session-imported',
          role: 'user',
          content: 'Imported message',
          timestamp: new Date().toISOString()
        }
      ]
    }
    expect(importData).toBeDefined()
    expect(importData.session.id).toBe('session-imported')
    expect(importData.messages).toHaveLength(1)
  })

  it('should define SessionUpdateRequest interface', () => {
    const request: SessionUpdateRequest = {
      id: 'session-1',
      title: 'Updated Title'
    }
    expect(request).toBeDefined()
    expect(request.id).toBe('session-1')
    expect(request.title).toBe('Updated Title')
  })

  it('should support optional fields in SessionUpdateRequest', () => {
    const request: SessionUpdateRequest = {
      id: 'session-1',
      metadata: { pinned: true }
    }
    expect(request.id).toBe('session-1')
    expect(request.metadata?.pinned).toBe(true)
    expect(request.title).toBeUndefined()
  })
})
