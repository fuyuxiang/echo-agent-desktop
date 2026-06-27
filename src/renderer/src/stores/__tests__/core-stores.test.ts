// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BridgeApi } from '@shared/types/api'

function installApi(): BridgeApi {
  const persisted = new Map<string, string>()
  const api = {
    store: {
      get: vi.fn(async (key: string) => persisted.get(key)),
      set: vi.fn(async (key: string, value: string) => {
        persisted.set(key, value)
      }),
      delete: vi.fn(async (key: string) => {
        persisted.delete(key)
      }),
      clear: vi.fn(async () => persisted.clear()),
      secureGet: vi.fn(async () => undefined),
      secureSet: vi.fn(async () => undefined),
      secureDelete: vi.fn(async () => undefined)
    },
    agent: {
      getScope: vi.fn(async () => ({ scope: 'restricted', workspaceDir: '/tmp/work' })),
      setScope: vi.fn(async () => ({ success: true }))
    },
    db: {
      session: {
        list: vi.fn(async () => [
          {
            chatId: 'c1',
            title: null,
            platform: 'desktop',
            createdAt: 1,
            lastActivity: 2,
            messageCount: 3,
            pinned: 1
          }
        ]),
        getMessages: vi.fn(async () => [
          {
            id: 1,
            chatId: 'c1',
            role: 'assistant',
            content: 'hello',
            reasoning: 'why',
            createdAt: 10
          }
        ]),
        upsert: vi.fn(),
        delete: vi.fn(),
        appendMessage: vi.fn(),
        deleteLastAssistantMessage: vi.fn(),
        updateTitle: vi.fn()
      },
      example: {
        list: vi.fn(),
        add: vi.fn(),
        remove: vi.fn(),
        clear: vi.fn()
      }
    }
  } as unknown as BridgeApi
  window.api = api
  return api
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  installApi()
})

describe('core stores', () => {
  it('app/agent/channel/skill/meeting stores 执行基础状态变更', async () => {
    const [
      { useAppStore },
      { useAgentStore },
      { useChannelStore },
      { useSkillStore },
      { useMeetingStore }
    ] = await Promise.all([
      import('../appStore'),
      import('../agentStore'),
      import('../channelStore'),
      import('../skillStore'),
      import('../meetingStore')
    ])

    useAppStore.getState().setTheme('dark')
    useAppStore.getState().setLanguage('en-US')
    useAppStore.getState().setLaunchAtLogin(true)
    expect(useAppStore.getState().settings).toMatchObject({
      theme: 'dark',
      language: 'en-US',
      launchAtLogin: true
    })

    useAgentStore.getState().setReady(true)
    useAgentStore.getState().setCurrentSessionKey('c1')
    useAgentStore.getState().addToolCall({
      id: 't1',
      tool: 'shell',
      args: '{}',
      status: 'started',
      timestamp: 1
    })
    useAgentStore.getState().setRetrievedMemories([{ id: 'm1', content: 'memo', tier: 'semantic' }])
    useAgentStore.getState().setCitations([{ path: '/a', chunk: 'c', score: 0.5 }])
    expect(useAgentStore.getState()).toMatchObject({
      ready: true,
      currentSessionKey: 'c1',
      toolCalls: [expect.objectContaining({ id: 't1' })],
      retrievedMemories: [{ id: 'm1', content: 'memo', tier: 'semantic' }],
      citations: [{ path: '/a', chunk: 'c', score: 0.5 }]
    })
    useAgentStore.getState().clearExecutionEvents()
    expect(useAgentStore.getState().toolCalls).toEqual([])
    expect(useAgentStore.getState().retrievedMemories).toEqual([])

    useChannelStore.getState().setChannels([{ id: 'ch1', name: '频道', enabled: true, running: false }])
    expect(useChannelStore.getState().channels[0].id).toBe('ch1')

    useSkillStore.getState().setSkills([{ id: 'ppt', label: 'PPT', description: 'd', kind: 'code' }])
    useSkillStore.getState().setSelectedSkill('ppt')
    useSkillStore.getState().setActiveSkill('ppt')
    expect(useSkillStore.getState()).toMatchObject({ selectedSkill: 'ppt', activeSkill: 'ppt' })

    useMeetingStore.getState().setActiveMeetingId('m1')
    useMeetingStore.getState().setRecording(true)
    useMeetingStore.getState().setMinimized(true)
    useMeetingStore.getState().setElapsedMs(1000)
    useMeetingStore.getState().setPartial('partial')
    useMeetingStore.getState().setAudioSource('mic+system')
    expect(useMeetingStore.getState()).toMatchObject({
      activeMeetingId: 'm1',
      recording: true,
      minimized: true,
      elapsedMs: 1000,
      partial: 'partial',
      audioSource: 'mic+system'
    })
    useMeetingStore.getState().reset()
    expect(useMeetingStore.getState()).toMatchObject({
      activeMeetingId: null,
      recording: false,
      minimized: false,
      elapsedMs: 0,
      partial: '',
      audioSource: 'mic'
    })
  })

  it('agentScopeStore 加载 scope，成功时更新，失败/异常时保留旧状态', async () => {
    const { useAgentScopeStore } = await import('../agentScopeStore')

    await useAgentScopeStore.getState().loadScope()
    expect(useAgentScopeStore.getState()).toMatchObject({
      scope: 'restricted',
      workspaceDir: '/tmp/work'
    })

    await expect(useAgentScopeStore.getState().applyScope('full', '')).resolves.toEqual({
      success: true
    })
    expect(useAgentScopeStore.getState()).toMatchObject({ scope: 'full', workspaceDir: '', switching: false })
    expect(window.api.agent.setScope).toHaveBeenCalledWith({ scope: 'full', workspaceDir: '' })

    vi.mocked(window.api.agent.setScope).mockResolvedValueOnce({
      success: false,
      error: 'no'
    } as unknown as { success: boolean })
    await expect(useAgentScopeStore.getState().applyScope('restricted', '/bad')).resolves.toEqual({
      success: false,
      error: 'no'
    })
    expect(useAgentScopeStore.getState()).toMatchObject({ scope: 'full', workspaceDir: '', switching: false })

    vi.mocked(window.api.agent.setScope).mockRejectedValueOnce(new Error('ipc down'))
    await expect(useAgentScopeStore.getState().applyScope('restricted', '/bad')).resolves.toEqual({
      success: false,
      error: 'ipc down'
    })
    expect(useAgentScopeStore.getState().switching).toBe(false)
  })

  it('electronStoreStorage 将 zustand persist 读写收口到 storage 门面', async () => {
    const { electronStoreStorage } = await import('../persist-storage')

    await electronStoreStorage.setItem('app', 'value')
    await expect(electronStoreStorage.getItem('app')).resolves.toBe('value')
    await electronStoreStorage.removeItem('app')
    await expect(electronStoreStorage.getItem('app')).resolves.toBeNull()
    expect(window.api.store.set).toHaveBeenCalledWith('zustand.app', 'value')
    expect(window.api.store.delete).toHaveBeenCalledWith('zustand.app')
  })

  it('chatStore 加载本地会话/消息并维护流式 assistant 状态', async () => {
    const { useChatStore } = await import('../chatStore')

    await useChatStore.getState().loadSessionsFromLocal()
    expect(useChatStore.getState().sessions).toEqual([
      {
        chatId: 'c1',
        title: undefined,
        platform: 'desktop',
        lastActivity: 2,
        messageCount: 3,
        pinned: true
      }
    ])

    useChatStore.getState().setIsGenerating(true)
    await useChatStore.getState().loadMessagesFromLocal('c1')
    expect(useChatStore.getState().messages).toEqual([
      {
        id: 'm-1',
        role: 'assistant',
        content: 'hello',
        reasoning: 'why',
        timestamp: 10
      }
    ])
    expect(useChatStore.getState().isGenerating).toBe(false)

    useChatStore.getState().clearMessages()
    useChatStore.getState().addSession({
      chatId: 'c2',
      title: '新会话',
      platform: 'desktop',
      lastActivity: 3,
      messageCount: 0
    })
    useChatStore.getState().updateSessionTitle('c2', '重命名')
    useChatStore.getState().setActiveChatId('c2')
    useChatStore.getState().setPendingPrimer('primer')
    expect(useChatStore.getState()).toMatchObject({ activeChatId: 'c2', pendingPrimer: 'primer' })
    expect(useChatStore.getState().sessions[0].title).toBe('重命名')

    useChatStore.getState().addUserMessage('hi', [{ id: 'a1', name: 'a.txt' }])
    useChatStore.getState().startAssistantMessage()
    useChatStore.getState().appendReasoningDelta('think')
    useChatStore.getState().appendStreamDelta('answer')
    expect(useChatStore.getState().messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'answer',
      reasoning: 'think',
      isStreaming: true
    })
    useChatStore.getState().finalizeAssistantMessage('final')
    expect(useChatStore.getState().messages.at(-1)).toMatchObject({
      content: 'final',
      reasoning: 'think\n\nanswer',
      isStreaming: false
    })
    expect(useChatStore.getState().isGenerating).toBe(false)

    useChatStore.getState().startAssistantMessage()
    useChatStore.getState().stopGenerating()
    expect(useChatStore.getState().messages.some((m) => m.isStreaming)).toBe(false)

    useChatStore.getState().startAssistantMessage()
    useChatStore.getState().appendStreamDelta('partial')
    const beforeRemove = useChatStore.getState().messages.length
    useChatStore.getState().removeLastAssistant()
    expect(useChatStore.getState().messages.length).toBe(beforeRemove - 1)
    expect(useChatStore.getState().messages.some((m) => m.isStreaming)).toBe(false)

    useChatStore.getState().clearMessages()
    expect(useChatStore.getState().messages).toEqual([])
    expect(useChatStore.getState().isGenerating).toBe(false)
  })
})
