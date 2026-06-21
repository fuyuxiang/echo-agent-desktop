import { useEffect, useRef, useState, useCallback } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { MessageBubble } from '@/components/MessageBubble'
import { FileDropZone } from '@/components/FileDropZone'
import { useChatStore } from '@/stores/chatStore'
import { useAgentStore } from '@/stores/agentStore'
import { useSkillStore } from '@/stores/skillStore'
import { agentWs } from '@/services/agent/ws'
import { knowledgeAPI } from '@/services/agent/knowledge'
import { skillsAPI } from '@/services/agent/skills'
import { buildProjectMemoryContext } from '@/services/chat-inject'
import { confirmShareToProject, type MemoryCandidate } from '@/services/memory-router'
import { ShareMemoryDialog } from '@/components/ShareMemoryDialog'
import { toast } from '@/components/Toast'
import { permission } from '@/utils/permission'
import styles from './chat.module.scss'

const CHINESE_OUTPUT_DIRECTIVE = [
  '输出规则：',
  '1. 默认使用简体中文进行流式输出和最终回答。',
  '2. 代码、命令、日志、API 字段、错误栈和专有名词可以保留原文。',
  '3. 如需说明处理过程，只输出简洁的中文过程摘要，不输出隐藏推理链路。'
].join('\n')

function getPayloadText(payload: Record<string, unknown>): string {
  const value = payload.text ?? payload.delta ?? payload.content ?? payload.message
  return typeof value === 'string' ? value : ''
}

function isReasoningPayload(payload: Record<string, unknown>): boolean {
  const meta = payload.metadata as Record<string, unknown> | undefined
  const rawKind =
    payload.stream_type ??
    payload.delta_type ??
    payload.content_type ??
    payload.phase ??
    meta?.stream_type ??
    meta?.delta_type ??
    meta?.content_type ??
    meta?.phase
  const kind = typeof rawKind === 'string' ? rawKind.toLowerCase() : ''
  return ['reasoning', 'thinking', 'thought', 'analysis', 'plan', 'process'].includes(kind)
}

function buildOutboundText(text: string, selectedSkill: string | null): string {
  const task = selectedSkill ? `请使用「${selectedSkill}」技能处理下面的任务：\n\n${text}` : text

  return `${CHINESE_OUTPUT_DIRECTIVE}\n\n用户任务：\n${task}`
}

export default function ChatPage(): React.JSX.Element {
  const messages = useChatStore((s) => s.messages)
  const addUserMessage = useChatStore((s) => s.addUserMessage)
  const startAssistantMessage = useChatStore((s) => s.startAssistantMessage)
  const appendStreamDelta = useChatStore((s) => s.appendStreamDelta)
  const appendReasoningDelta = useChatStore((s) => s.appendReasoningDelta)
  const finalizeAssistantMessage = useChatStore((s) => s.finalizeAssistantMessage)

  const wsConnected = useAgentStore((s) => s.wsConnected)
  const baseUrl = useAgentStore((s) => s.baseUrl)
  const setWsConnected = useAgentStore((s) => s.setWsConnected)
  const setCurrentSessionKey = useAgentStore((s) => s.setCurrentSessionKey)
  const clearExecutionEvents = useAgentStore((s) => s.clearExecutionEvents)
  const skills = useSkillStore((s) => s.skills)
  const setSkills = useSkillStore((s) => s.setSkills)
  const selectedSkill = useSkillStore((s) => s.selectedSkill)

  const [inputText, setInputText] = useState('')
  const [uploading, setUploading] = useState(false)
  const [listening, setListening] = useState(false)
  // 待分流确认的项目记忆候选（null 表示当前无弹窗）
  const [candidate, setCandidate] = useState<MemoryCandidate | null>(null)
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const recognitionRef = useRef<{
    streamId: string
    context: AudioContext
    source: MediaStreamAudioSourceNode
    processor: ScriptProcessorNode
    stream: MediaStream
    pollTimer: ReturnType<typeof setInterval>
  } | null>(null)
  const composerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (skills.length > 0) return
    skillsAPI
      .list()
      .then((data) => setSkills(data.skills ?? []))
      .catch(() => {})
  }, [skills.length, setSkills])

  useEffect(() => {
    if (!baseUrl) return

    const wsUrl = baseUrl.replace(/^http/, 'ws') + '/ws'
    const { currentSessionKey: sessionKey, remoteToken } = useAgentStore.getState()
    agentWs.connect(wsUrl, sessionKey || 'default', remoteToken)

    const onAuthOk = (payload: Record<string, unknown>): void => {
      setWsConnected(true)
      if (payload.session_key) setCurrentSessionKey(payload.session_key as string)
    }

    const onStreaming = (payload: Record<string, unknown>): void => {
      if (!useChatStore.getState().isGenerating) startAssistantMessage()
      const text = getPayloadText(payload)
      if (!text) return

      if (isReasoningPayload(payload)) {
        appendReasoningDelta(text)
      } else {
        appendStreamDelta(text)
      }
    }

    const onFinal = (payload: Record<string, unknown>): void => {
      finalizeAssistantMessage(getPayloadText(payload))

      const state = useChatStore.getState()
      const userMessages = state.messages.filter((m) => m.role === 'user')
      const activeKey = state.activeViewKey
      if (userMessages.length === 1 && activeKey) {
        const session = state.sessions.find((s) => s.viewKey === activeKey)
        if (session && (!session.title || session.title === '新对话')) {
          const raw = userMessages[0].content
          const cleaned = raw
            .replace(CHINESE_OUTPUT_DIRECTIVE, '')
            .replace(/^用户任务：\n?/, '')
            .trim()
          const title = cleaned.length > 20 ? cleaned.slice(0, 20) + '...' : cleaned
          if (title) state.updateSessionTitle(activeKey, title)
        }
      }
    }

    const onDisconnected = (): void => {
      setWsConnected(false)
    }

    const onProgress = (payload: Record<string, unknown>): void => {
      const meta = payload.metadata as Record<string, unknown> | undefined
      if (!meta) return
      const type = meta.progress_type as string

      if (type === 'tool_call' || type === 'tool_result') {
        useAgentStore.getState().addToolCall({
          id: `tc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          tool: (meta.tool as string) ?? '',
          args: type === 'tool_call' ? ((meta.args as string) ?? '') : '',
          status:
            type === 'tool_result'
              ? 'done'
              : ((meta.status as 'started' | 'done' | 'error') ?? 'started'),
          result: type === 'tool_result' ? ((meta.result_preview as string) ?? '') : undefined,
          durationMs: type === 'tool_result' ? (meta.duration_ms as number) : undefined,
          timestamp: Date.now()
        })
      } else if (type === 'memory_retrieved') {
        useAgentStore
          .getState()
          .setRetrievedMemories(
            (meta.entries as Array<{ id: string; content: string; tier: string }>) ?? []
          )
      } else if (type === 'knowledge_cited') {
        useAgentStore
          .getState()
          .setCitations(
            (meta.citations as Array<{ path: string; chunk: string; score: number }>) ?? []
          )
      }
    }

    agentWs.on('auth_ok', onAuthOk)
    agentWs.on('message.streaming', onStreaming)
    agentWs.on('message.final', onFinal)
    agentWs.on('message.progress', onProgress)
    agentWs.on('_disconnected', onDisconnected)

    return () => {
      agentWs.off('auth_ok', onAuthOk)
      agentWs.off('message.streaming', onStreaming)
      agentWs.off('message.final', onFinal)
      agentWs.off('message.progress', onProgress)
      agentWs.off('_disconnected', onDisconnected)
      agentWs.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl])

  useEffect(() => {
    virtuosoRef.current?.scrollToIndex({ index: messages.length - 1, behavior: 'smooth' })
  }, [messages.length])

  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        clearInterval(recognitionRef.current.pollTimer)
        recognitionRef.current.processor.disconnect()
        recognitionRef.current.source.disconnect()
        recognitionRef.current.stream.getTracks().forEach((t) => t.stop())
        recognitionRef.current.context.close()
        window.api.asr.stop(recognitionRef.current.streamId)
      }
    }
  }, [])

  const handleSend = useCallback(async () => {
    const text = inputText.trim()
    if (!text || !wsConnected) return
    addUserMessage(text)
    clearExecutionEvents()
    setInputText('')
    // 注入项目记忆上下文（服务器不可达时降级为空串，不影响正常发送）
    const memoryContext = await buildProjectMemoryContext(text)
    const outbound = buildOutboundText(text, selectedSkill)
    const finalText = memoryContext ? `${memoryContext}\n\n${outbound}` : outbound
    agentWs.sendMessage(finalText)
  }, [inputText, wsConnected, selectedSkill, addUserMessage, clearExecutionEvents])

  // 分流确认：用户在 ShareMemoryDialog 选择后调用，写入结果并提示
  const handleMemoryDecide = useCallback(
    async (decision: 'share' | 'local' | 'discard') => {
      if (!candidate) return
      const current = candidate
      setCandidate(null)
      try {
        const { shared } = await confirmShareToProject(current, decision)
        if (shared) toast.success('已共享到项目记忆')
      } catch {
        toast.error('共享到项目记忆失败')
      }
    },
    [candidate]
  )

  // TODO(Task 11 联调): 候选来源待与 echo-agent 联调确定——
  // 目前 WS 协议尚未约定"值得共享的项目记忆候选"的下行信号，
  // 不臆造协议、不做假数据自动弹窗。届时在收到该信号处调用 setCandidate(candidate) 即可触发弹窗。

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }

  const uploadFiles = async (files: File[]): Promise<void> => {
    if (files.length === 0) return
    setUploading(true)
    try {
      let successCount = 0
      const failed: string[] = []

      for (const file of files) {
        try {
          await knowledgeAPI.upload(file)
          successCount++
        } catch {
          failed.push(file.name)
        }
      }

      if (successCount > 0) toast.success(`已上传 ${successCount} 个文件到知识库`)
      if (failed.length > 0) toast.error(`上传失败：${failed.join('、')}`)
    } finally {
      setUploading(false)
    }
  }

  const handleFileDrop = async (files: File[]): Promise<void> => {
    await uploadFiles(files)
  }

  const handleFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    await uploadFiles(files)
  }

  const handleVoiceInput = async (): Promise<void> => {
    if (listening) {
      if (recognitionRef.current) {
        clearInterval(recognitionRef.current.pollTimer)
        recognitionRef.current.processor.disconnect()
        recognitionRef.current.source.disconnect()
        recognitionRef.current.stream.getTracks().forEach((t) => t.stop())
        recognitionRef.current.context.close()
        const finalText = await window.api.asr.stop(recognitionRef.current.streamId)
        if (finalText) {
          setInputText((current) => (current ? `${current}\n${finalText}` : finalText))
        }
        recognitionRef.current = null
      }
      setListening(false)
      return
    }

    const permissionStatus = await permission.request('microphone')
    if (permissionStatus !== 'granted') {
      toast.error('麦克风权限未开启')
      return
    }

    let mediaStream: MediaStream
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      toast.error('无法访问麦克风')
      return
    }

    try {
      const streamId = await window.api.asr.start()
      const context = new AudioContext({ sampleRate: 16000 })
      const source = context.createMediaStreamSource(mediaStream)
      const processor = context.createScriptProcessor(4096, 1, 1)

      processor.onaudioprocess = (e): void => {
        const inputData = e.inputBuffer.getChannelData(0)
        const samples = new Float32Array(inputData)
        window.api.asr.feed(streamId, samples)
      }

      source.connect(processor)
      processor.connect(context.destination)

      const pollTimer = setInterval(async () => {
        const text = await window.api.asr.getResult(streamId)
        if (text) {
          setInputText(text)
        }
      }, 300)

      recognitionRef.current = {
        streamId,
        context,
        source,
        processor,
        stream: mediaStream,
        pollTimer
      }
      setListening(true)
    } catch {
      mediaStream.getTracks().forEach((t) => t.stop())
      toast.error('语音识别启动失败')
    }
  }

  const canSend = wsConnected && inputText.trim().length > 0

  return (
    <div className={styles.page}>
      <div className={styles.chatArea}>
        <FileDropZone onDrop={handleFileDrop}>
          <div className={styles.messageList}>
            {messages.length === 0 && (
              <div className={styles.emptyState}>
                <div className={styles.emptyMark}>E</div>
                <h2>本地工作台已就绪</h2>
                <p>{wsConnected ? '等待新的任务。' : '正在等待 Agent 连接。'}</p>
              </div>
            )}
            <Virtuoso
              ref={virtuosoRef}
              data={messages}
              itemContent={(_, msg) => <MessageBubble message={msg} />}
              followOutput="smooth"
              className={styles.virtuoso}
            />
          </div>
        </FileDropZone>

        <div className={styles.composer} ref={composerRef}>
          <textarea
            className={styles.input}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              wsConnected
                ? '今天帮你做些什么？@ 引用对话文件，/ 调用技能与指令'
                : '等待 Agent 连接...'
            }
            disabled={!wsConnected}
            rows={4}
          />
          <div className={styles.composerBar}>
            <div className={styles.composerTools}></div>
            <div className={styles.composerActions}>
              <button
                className={styles.iconBtn}
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                title={uploading ? '上传中' : '上传文件'}
                aria-label={uploading ? '上传中' : '上传文件'}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M12 5v14m-7-7h14"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
              <button
                className={`${styles.iconBtn} ${listening ? styles.listening : ''}`}
                onClick={handleVoiceInput}
                title={listening ? '停止语音输入' : '语音输入'}
                aria-label={listening ? '停止语音输入' : '语音输入'}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3z"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  />
                  <path
                    d="M5 11a7 7 0 0 0 14 0M12 18v3"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
              <button className={styles.sendBtn} onClick={() => void handleSend()} disabled={!canSend}>
                <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M5 12h13m0 0-5-5m5 5-5 5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={handleFileInputChange}
            />
          </div>
        </div>
      </div>
      {candidate && <ShareMemoryDialog candidate={candidate} onDecide={handleMemoryDecide} />}
    </div>
  )
}
