// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BridgeApi } from '@shared/types/api'
import type { ChatMessage } from '@/stores/chatStore'

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn()
}))

const clipboard = vi.hoisted(() => ({
  writeText: vi.fn(async () => undefined)
}))

const highlightCode = vi.hoisted(() => vi.fn(async () => '<pre><code>highlighted</code></pre>'))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params?.program ? `${key}:${params.program}` : key
  })
}))
vi.mock('@/components/Toast', () => ({ toast }))
vi.mock('@/utils/clipboard', () => ({ clipboard }))
vi.mock('@/utils/highlighter', () => ({ highlightCode }))

function installApi(): BridgeApi {
  const api = {
    store: {
      get: vi.fn(async () => undefined),
      set: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
      secureGet: vi.fn(async () => undefined),
      secureSet: vi.fn(async () => undefined),
      secureDelete: vi.fn(async () => undefined)
    },
    agent: {
      getScope: vi.fn(async () => ({ scope: 'full', workspaceDir: '' })),
      setScope: vi.fn(async () => ({ success: true }))
    },
    system: {
      showOpenDialog: vi.fn(async () => ['/tmp/work']),
      notify: vi.fn(),
      clipboardReadText: vi.fn(),
      clipboardWriteText: vi.fn(),
      openExternal: vi.fn(),
      showItemInFolder: vi.fn(),
      showSaveDialog: vi.fn(),
      httpProxy: vi.fn()
    }
  } as unknown as BridgeApi
  window.api = api
  return api
}

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  installApi()
  const { useMeetingStore } = await import('@/stores/meetingStore')
  useMeetingStore.getState().reset()
  const { useAgentScopeStore } = await import('@/stores/agentScopeStore')
  useAgentScopeStore.setState({ scope: 'full', workspaceDir: '', switching: false })
  const { useChatStore } = await import('@/stores/chatStore')
  useChatStore.getState().clearMessages()
  useChatStore.setState({ isGenerating: false })
})

describe('basic components', () => {
  it('FileDropZone 显示拖放 overlay 并把文件回调给调用方', async () => {
    const { FileDropZone } = await import('../FileDropZone')
    const onDrop = vi.fn()
    render(<FileDropZone onDrop={onDrop}>content</FileDropZone>)

    const zone = screen.getByText('content')
    fireEvent.dragOver(zone)
    expect(screen.getByText('拖放文件到此处作为对话附件')).toBeTruthy()
    const file = new File(['a'], 'a.txt')
    fireEvent.drop(zone, { dataTransfer: { files: [file] } })
    expect(onDrop).toHaveBeenCalledWith([file])
    expect(screen.queryByText('拖放文件到此处作为对话附件')).toBeNull()
  })

  it('ListPanel 仅 visible=true 时渲染内容', async () => {
    const { ListPanel } = await import('../ListPanel')
    const { rerender } = render(<ListPanel visible={false}>hidden</ListPanel>)
    expect(screen.queryByText('hidden')).toBeNull()
    rerender(<ListPanel visible>shown</ListPanel>)
    expect(screen.getByText('shown')).toBeTruthy()
  })

  it('MeetingButton 根据 meetingStore 录制态切换文案并触发 onStart', async () => {
    const { MeetingButton } = await import('../MeetingButton')
    const { useMeetingStore } = await import('@/stores/meetingStore')
    const onStart = vi.fn()
    const { rerender } = render(<MeetingButton disabled={false} onStart={onStart} />)
    fireEvent.click(screen.getByText('chat.meeting.trigger'))
    expect(onStart).toHaveBeenCalledTimes(1)

    useMeetingStore.getState().setRecording(true)
    rerender(<MeetingButton disabled={false} onStart={onStart} />)
    expect(screen.getByText('chat.meeting.recording')).toBeTruthy()
  })

  it('MessageBubble 渲染用户附件、assistant actions，并支持复制/重新生成', async () => {
    const { MessageBubble } = await import('../MessageBubble')
    const onRegenerate = vi.fn()
    const userMessage: ChatMessage = {
      id: 'u1',
      role: 'user',
      content: 'hello',
      timestamp: 1,
      attachments: [{ id: 'a1', name: 'a.txt' }]
    }
    const { rerender } = render(<MessageBubble message={userMessage} />)
    expect(screen.getByText('a.txt')).toBeTruthy()
    expect(screen.getByText('hello')).toBeTruthy()

    const assistantMessage: ChatMessage = {
      id: 'a1',
      role: 'assistant',
      content: 'answer',
      timestamp: 2
    }
    rerender(<MessageBubble message={assistantMessage} onRegenerate={onRegenerate} />)
    fireEvent.click(screen.getByText('chat.copy'))
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith('answer'))
    expect(toast.success).toHaveBeenCalledWith('chat.copied')
    fireEvent.click(screen.getByText('chat.regenerate'))
    expect(onRegenerate).toHaveBeenCalledTimes(1)

    rerender(<MessageBubble message={{ ...assistantMessage, content: '', isStreaming: true }} />)
    expect(screen.getByText('chat.thinking')).toBeTruthy()
  })

  it('ShareMemoryDialog 把三个决策回调给调用方', async () => {
    const { ShareMemoryDialog } = await import('../ShareMemoryDialog')
    const onDecide = vi.fn()
    render(
      <ShareMemoryDialog
        candidate={{ content: '需要共享的记忆', tags: ['team'], reason: '团队可复用' }}
        onDecide={onDecide}
      />
    )
    expect(screen.getByText('需要共享的记忆')).toBeTruthy()
    fireEvent.click(screen.getByText('memory.share'))
    fireEvent.click(screen.getByText('memory.localOnly'))
    fireEvent.click(screen.getByText('memory.discard'))
    expect(onDecide.mock.calls.map((c) => c[0])).toEqual(['share', 'local', 'discard'])
  })

  it('StreamRenderer 流式时跳过高亮，完成后异步高亮代码块', async () => {
    const { StreamRenderer } = await import('../StreamRenderer')
    const markdown = '```ts\nconst a = 1\n```'
    const { rerender } = render(<StreamRenderer content={markdown} isStreaming />)
    expect(screen.getByText('const a = 1')).toBeTruthy()
    expect(highlightCode).not.toHaveBeenCalled()

    rerender(<StreamRenderer content={markdown} />)
    await waitFor(() => expect(highlightCode).toHaveBeenCalledWith('const a = 1', 'ts', 'light'))
    expect(screen.getByText('highlighted')).toBeTruthy()
  })

  it('ScopeSwitcher 选择 restricted 工作目录并应用到 agentScopeStore', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { ScopeSwitcher } = await import('../ScopeSwitcher')
    const { useAgentScopeStore } = await import('@/stores/agentScopeStore')

    render(<ScopeSwitcher />)
    fireEvent.click(screen.getByText('scope.full'))
    fireEvent.click(screen.getByLabelText(/scope.restricted/))
    fireEvent.click(screen.getByText('scope.chooseFolder'))
    await waitFor(() => expect(window.api.system.showOpenDialog).toHaveBeenCalledWith({ properties: ['openDirectory'] }))
    fireEvent.click(screen.getByText('scope.apply'))

    await waitFor(() =>
      expect(window.api.agent.setScope).toHaveBeenCalledWith({
        scope: 'restricted',
        workspaceDir: '/tmp/work'
      })
    )
    expect(useAgentScopeStore.getState()).toMatchObject({
      scope: 'restricted',
      workspaceDir: '/tmp/work',
      switching: false
    })
    expect(toast.success).toHaveBeenCalledWith('scope.switched')
    confirm.mockRestore()
  })
})
